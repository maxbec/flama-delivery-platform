import type { ArtifactReference, DeploymentAdapter, DeploymentManifest } from "../orchestrator.js";
import type { CommandRunner } from "./docker-compose.js";

/**
 * Plan section 14 forbids rebuilding source during deployment, so this provider
 * uploads the output of an earlier trusted `vercel build` with `--prebuilt`.
 *
 * Verification reads back from Vercel's own record rather than from what the
 * adapter just did. That matters: `vercel inspect` has no machine-readable output,
 * so the only CLI-only way to satisfy `deployedVersion` would be to return the
 * version the adapter deployed, which would make the orchestrator's
 * `deployedVersion === expectedVersion` check tautological and let a failed
 * deployment verify. Plan section 4 forbids advancing an externally verifiable
 * state by claiming success, so the REST deployment record is consulted instead.
 */

export type VercelReadyState =
  | "BLOCKED"
  | "BUILDING"
  | "CANCELED"
  | "ERROR"
  | "INITIALIZING"
  | "QUEUED"
  | "READY";

export interface VercelDeployment {
  readonly url: string;
  readonly readyState: VercelReadyState | string;
  readonly target: "production" | "staging" | null;
  readonly meta: Readonly<Record<string, string>>;
}

export interface VercelDeploymentReader {
  read(idOrUrl: string): Promise<VercelDeployment>;
}

export interface VercelCredential {
  reveal(): string;
}

export interface VercelConfiguration {
  readonly projectId: string;
  readonly deploymentUrl: string;
  readonly scope?: string;
}

/** The meta key under which the released version is recorded at deploy time. */
export const vercelVersionMetaKey = "flamaVersion";

const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const prebuiltOutputPath = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._\-/]+$/u;

function isDeploymentUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.username.length === 0 && url.password.length === 0;
}

export function createVercelAdapter(
  configuration: VercelConfiguration,
  runner: CommandRunner,
  reader: VercelDeploymentReader,
  credential: VercelCredential,
  now: () => Date = () => new Date(),
): DeploymentAdapter {
  /** The deployment this adapter last put into production, read back for verification. */
  let currentDeployment: string | undefined;

  const scopeArguments = configuration.scope === undefined ? [] : ["--scope", configuration.scope];

  async function vercel(args: readonly string[]): Promise<string> {
    // The token travels in the environment, never in the argument list, so it
    // cannot appear in a process listing or a log.
    const result = await runner.run("vercel", args, { VERCEL_TOKEN: credential.reveal() });
    if (result.code !== 0) throw new Error("vercel command failed");
    return result.stdout.trim();
  }

  async function observe(): Promise<VercelDeployment> {
    if (currentDeployment === undefined) {
      throw new Error("no deployment has been performed by this adapter");
    }
    return reader.read(currentDeployment);
  }

  return {
    name: "vercel-prebuilt",

    async validate(manifest: DeploymentManifest): Promise<boolean> {
      if (!digestPattern.test(manifest.artifact.digest)) return false;
      // The artifact is prebuilt output in the checkout, never a registry reference.
      if (!prebuiltOutputPath.test(manifest.artifact.uri) || manifest.artifact.uri.includes(":")) return false;
      if (manifest.previousArtifact !== null) {
        // An instant rollback targets a previous deployment URL, not an artifact path.
        if (
          !digestPattern.test(manifest.previousArtifact.digest) ||
          !isDeploymentUrl(manifest.previousArtifact.uri)
        ) return false;
      }
      return true;
    },

    async deploy(_artifact: ArtifactReference, manifest: DeploymentManifest): Promise<void> {
      const stdout = await vercel([
        "deploy",
        "--prebuilt",
        "--prod",
        "--non-interactive",
        "--archive=tgz",
        "--meta",
        `${vercelVersionMetaKey}=${manifest.version}`,
        ...scopeArguments,
      ]);
      // Vercel documents that deploy stdout is always the deployment URL. Anything
      // else means the contract changed, and guessing would hide a failed deploy.
      const deploymentUrl = stdout.split("\n").at(-1)?.trim() ?? "";
      if (!isDeploymentUrl(deploymentUrl)) {
        throw new Error("vercel deploy did not report a deployment URL");
      }
      currentDeployment = deploymentUrl;
    },

    async health(): Promise<boolean> {
      const deployment = await observe();
      return deployment.readyState === "READY" && deployment.target === "production";
    },

    async rollback(previousArtifact: ArtifactReference): Promise<void> {
      if (!isDeploymentUrl(previousArtifact.uri)) {
        throw new Error("rollback target is not a previous deployment URL");
      }
      await vercel(["rollback", previousArtifact.uri, "--non-interactive", ...scopeArguments]);
      currentDeployment = previousArtifact.uri;
    },

    async deploymentUrl(): Promise<string> {
      return configuration.deploymentUrl;
    },

    async deployedVersion(): Promise<string> {
      const deployment = await observe();
      const version = deployment.meta[vercelVersionMetaKey];
      if (version === undefined || version.length === 0) {
        throw new Error("vercel recorded no version for the deployment");
      }
      return version;
    },

    async evidence() {
      const deployment = await observe();
      if (deployment.url.length === 0) throw new Error("vercel reported no deployment identity");
      return { deploymentId: deployment.url, observedAt: now().toISOString() };
    },
  };
}
