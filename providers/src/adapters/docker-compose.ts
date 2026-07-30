import type { ArtifactReference, DeploymentAdapter, DeploymentManifest } from "../orchestrator.js";

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
}

export interface CommandRunner {
  run(
    command: string,
    args: readonly string[],
    environment?: Readonly<Record<string, string>>,
  ): Promise<CommandResult>;
}

export interface DockerComposeConfiguration {
  readonly composeFile: string;
  readonly projectName: string;
  readonly service: string;
  readonly deploymentUrl: string;
}

/**
 * A DigitalOcean Droplet and a Hostinger VPS are both a server running Docker, so
 * they are the same deployment mechanism bound to a remote Docker endpoint rather
 * than two separate ones. The adapter still reports its own provider name so the
 * manifest, the loader check, and the recorded evidence stay exact.
 */
export type DockerHostProvider = "docker-compose" | "digitalocean-droplet" | "hostinger-vps";

export interface DockerHostConfiguration extends DockerComposeConfiguration {
  readonly provider: DockerHostProvider;
  readonly dockerHost?: string;
}

const digestPattern = /^sha256:[0-9a-f]{64}$/u;

/**
 * Plan section 14 requires Docker deployments to reference signed images by
 * immutable digest and never by a mutable tag, so a reference is acceptable only
 * when it pins the exact digest the manifest recorded.
 */
function pinnedToDigest(artifact: ArtifactReference): boolean {
  if (!digestPattern.test(artifact.digest)) return false;
  const [repository, reference] = artifact.uri.split("@");
  return (
    repository !== undefined && repository.length > 0 &&
    !repository.includes(":") &&
    reference === artifact.digest
  );
}

interface ComposeService {
  readonly id: string;
  readonly image: string;
  readonly state: string;
  readonly health: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function composeService(value: unknown, service: string): ComposeService | undefined {
  if (!isRecord(value) || value["Service"] !== service) return undefined;
  const { ID: id, Image: image, State: state, Health: health } = value;
  if (typeof id !== "string" || typeof image !== "string" || typeof state !== "string") return undefined;
  return { id, image, state, health: typeof health === "string" ? health : "" };
}

/**
 * Compose has emitted `ps --format json` both as one object per line and as a
 * single array depending on the release, so both shapes are accepted. Anything
 * else yields no service, which callers treat as unhealthy rather than guessing.
 */
function parseComposeService(stdout: string, service: string): ComposeService | undefined {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return undefined;
  let documents: unknown[];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    documents = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    documents = [];
    for (const line of trimmed.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        documents.push(JSON.parse(line) as unknown);
      } catch {
        return undefined;
      }
    }
  }
  for (const document of documents) {
    const matched = composeService(document, service);
    if (matched !== undefined) return matched;
  }
  return undefined;
}

export function createDockerComposeAdapter(
  configuration: DockerComposeConfiguration,
  runner: CommandRunner,
  now?: () => Date,
): DeploymentAdapter {
  return createDockerHostAdapter({ ...configuration, provider: "docker-compose" }, runner, now);
}

export function createDockerHostAdapter(
  configuration: DockerHostConfiguration,
  runner: CommandRunner,
  now: () => Date = () => new Date(),
): DeploymentAdapter {
  const remote: Readonly<Record<string, string>> | undefined = configuration.dockerHost === undefined
    ? undefined
    : { DOCKER_HOST: configuration.dockerHost };
  const composeArguments = (...trailing: readonly string[]): readonly string[] => [
    "compose",
    "--file",
    configuration.composeFile,
    "--project-name",
    configuration.projectName,
    ...trailing,
  ];

  async function must(
    args: readonly string[],
    environment?: Readonly<Record<string, string>>,
  ): Promise<CommandResult> {
    const merged = remote === undefined && environment === undefined
      ? undefined
      : { ...remote, ...environment };
    const result = await runner.run("docker", args, merged);
    if (result.code !== 0) throw new Error("docker command failed");
    return result;
  }

  /**
   * Providers must not rebuild source during deployment, so the image is pulled
   * by digest and handed to compose through the environment. `--no-build`
   * guarantees a compose file with a `build:` stanza still cannot compile source
   * on the deployment runner.
   */
  async function start(artifact: ArtifactReference): Promise<void> {
    if (!pinnedToDigest(artifact)) throw new Error("artifact is not pinned to its digest");
    await must(["pull", artifact.uri]);
    await must(
      composeArguments("up", "--detach", "--no-build", configuration.service),
      { FLAMA_IMAGE: artifact.uri },
    );
  }

  async function observe(): Promise<ComposeService | undefined> {
    const result = await must(composeArguments("ps", "--format", "json", configuration.service));
    return parseComposeService(result.stdout, configuration.service);
  }

  async function observeOrFail(): Promise<ComposeService> {
    const service = await observe();
    if (service === undefined) throw new Error("compose reported no matching service");
    return service;
  }

  return {
    name: configuration.provider,

    async validate(manifest: DeploymentManifest): Promise<boolean> {
      if (!pinnedToDigest(manifest.artifact)) return false;
      if (manifest.previousArtifact !== null && !pinnedToDigest(manifest.previousArtifact)) return false;
      return true;
    },

    async deploy(artifact: ArtifactReference): Promise<void> {
      await start(artifact);
    },

    /**
     * An explicit passing healthcheck is required. A running container without a
     * healthcheck is reported unhealthy so a deployment can never be verified by
     * process liveness alone.
     */
    async health(): Promise<boolean> {
      const service = await observe();
      return service !== undefined && service.state === "running" && service.health === "healthy";
    },

    async rollback(previousArtifact: ArtifactReference): Promise<void> {
      await start(previousArtifact);
    },

    async deploymentUrl(): Promise<string> {
      return configuration.deploymentUrl;
    },

    async deployedVersion(): Promise<string> {
      const service = await observeOrFail();
      const result = await must([
        "image",
        "inspect",
        service.image,
        "--format",
        '{{index .Config.Labels "org.opencontainers.image.version"}}',
      ]);
      const version = result.stdout.trim();
      if (version.length === 0 || version === "<no value>") {
        throw new Error("deployed image carries no OCI version label");
      }
      return version;
    },

    async evidence() {
      const service = await observeOrFail();
      return { deploymentId: service.id, observedAt: now().toISOString() };
    },
  };
}
