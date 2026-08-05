import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  DeploymentAdapter,
  DeploymentClock,
  ProviderName,
  VerificationRunner,
} from "./orchestrator.js";
import type { CommandResult, CommandRunner } from "./adapters/docker-compose.js";

const providerNames = new Set<ProviderName>([
  "docker-compose",
  "vercel-prebuilt",
  "digitalocean-app",
  "digitalocean-droplet",
  "hostinger-vps",
  "coolify",
  "render",
  "custom",
]);

function isFunctionProperty(value: object, key: string): boolean {
  return typeof Reflect.get(value, key) === "function";
}

function isDeploymentAdapter(value: unknown): value is DeploymentAdapter {
  if (typeof value !== "object" || value === null) return false;
  const name = Reflect.get(value, "name");
  return (
    typeof name === "string" &&
    providerNames.has(name as ProviderName) &&
    ["validate", "deploy", "health", "rollback", "deploymentUrl", "deployedVersion", "evidence"].every(
      (key) => isFunctionProperty(value, key),
    )
  );
}

export async function loadDeploymentAdapter(
  workingDirectory: string,
  adapterPath: string,
  expectedProvider: ProviderName,
): Promise<DeploymentAdapter> {
  if (isAbsolute(adapterPath) || adapterPath.split(/[\\/]/u).includes("..")) {
    throw new Error("adapter path must be repository relative");
  }
  const root = resolve(workingDirectory);
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("working directory must be a real directory");
  }
  const path = resolve(root, adapterPath);
  const relativePath = relative(root, path);
  if (relativePath.startsWith(`..${sep}`) || relativePath === "..") {
    throw new Error("adapter path escaped repository");
  }
  let current = root;
  for (const component of relative(root, dirname(path)).split(sep).filter(Boolean)) {
    current = join(current, component);
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("adapter parent must be a real directory");
    }
  }
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("adapter must be a regular file");
  }

  const require = createRequire(import.meta.url);
  const module: unknown = require(path);
  if (typeof module !== "object" || module === null) throw new Error("invalid adapter module");
  const createAdapter = Reflect.get(module, "createAdapter");
  if (typeof createAdapter !== "function") throw new Error("adapter factory is missing");
  const adapter: unknown = await Reflect.apply(createAdapter, undefined, []);
  if (!isDeploymentAdapter(adapter) || adapter.name !== expectedProvider) {
    throw new Error("adapter does not match deployment provider");
  }
  return adapter;
}

/**
 * Deployment values reach the provider through the environment, never through
 * the argument list, and the child receives only an explicit minimal environment
 * plus any Docker endpoint selection. That keeps an unrelated parent variable
 * from silently becoming part of a deployment, and keeps values out of process
 * listings.
 */
export class SystemCommandRunner implements CommandRunner {
  static readonly #inheritedNames = ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"];
  static readonly #maximumOutputBytes = 1024 * 1024;

  constructor(private readonly workingDirectory?: string) {}

  async run(
    command: string,
    args: readonly string[],
    environment?: Readonly<Record<string, string>>,
  ): Promise<CommandResult> {
    if (!/^[a-z0-9][a-z0-9._-]*$/iu.test(command)) {
      throw new Error("command must be a bare executable name");
    }
    for (const value of Object.values(environment ?? {})) {
      if (/[\r\n\0]/u.test(value)) throw new Error("environment value is not a single line");
    }
    const inherited: Record<string, string> = {};
    for (const name of SystemCommandRunner.#inheritedNames) {
      const value = process.env[name];
      if (value !== undefined) inherited[name] = value;
    }

    return new Promise<CommandResult>((resolveRun, rejectRun) => {
      const child = spawn(command, [...args], {
        ...(this.workingDirectory === undefined ? {} : { cwd: this.workingDirectory }),
        env: { ...inherited, ...environment },
        shell: false,
        stdio: ["ignore", "pipe", "inherit"],
      });
      let stdout = "";
      let truncated = false;
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (truncated) return;
        stdout += chunk;
        if (Buffer.byteLength(stdout, "utf8") > SystemCommandRunner.#maximumOutputBytes) {
          truncated = true;
          child.kill("SIGKILL");
        }
      });
      child.once("error", rejectRun);
      child.once("close", (code, signal) => {
        if (truncated) {
          rejectRun(new Error("command produced more output than the runner accepts"));
          return;
        }
        resolveRun({ code: signal === null && code !== null ? code : 1, stdout });
      });
    });
  }
}

export class SystemDeploymentClock implements DeploymentClock {
  now(): Date {
    return new Date();
  }

  async wait(seconds: number): Promise<void> {
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, seconds * 1_000));
  }
}

export class RepositoryVerificationRunner implements VerificationRunner {
  constructor(private readonly workingDirectory: string) {}

  async smoke(): Promise<boolean> {
    return new Promise<boolean>((resolveSmoke, rejectSmoke) => {
      const child = spawn("./scripts/delivery", ["smoke"], {
        cwd: this.workingDirectory,
        env: process.env,
        shell: false,
        stdio: "inherit",
      });
      child.once("error", rejectSmoke);
      child.once("exit", (code, signal) => {
        resolveSmoke(signal === null && code === 0);
      });
    });
  }
}
