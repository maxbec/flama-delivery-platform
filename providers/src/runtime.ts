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
