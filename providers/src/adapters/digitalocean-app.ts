import type { ArtifactReference, DeploymentAdapter, DeploymentManifest } from "../orchestrator.js";

/**
 * App Platform deploys the image recorded in the app spec, so a deployment is a
 * spec update that pins the exact digest followed by one created deployment.
 *
 * DigitalOcean's published specification makes `digest` mutually exclusive with
 * `tag` and defaults `tag` to `latest` when neither is given, which is precisely
 * what plan section 14 forbids. The adapter therefore always writes `digest` and
 * removes `tag`.
 *
 * Verification reads the live digest back out of the app spec. That is a genuine
 * external read rather than a restatement of what the adapter just did: if
 * anything re-points the app after deployment, the read-back digest no longer
 * matches and verification fails.
 */

export type DigitalOceanRegistryType = "DOCKER_HUB" | "DOCR" | "GHCR";

export interface DigitalOceanImageSource {
  readonly registry_type: DigitalOceanRegistryType;
  readonly registry?: string;
  readonly repository: string;
  readonly tag?: string;
  readonly digest?: string;
}

export interface DigitalOceanService {
  readonly name: string;
  readonly image: DigitalOceanImageSource;
}

export interface DigitalOceanAppSpec {
  readonly name: string;
  readonly services: readonly DigitalOceanService[];
}

/** Published phase enumeration; `ACTIVE` is the only successful terminal phase. */
export type DigitalOceanPhase =
  | "UNKNOWN"
  | "PENDING_BUILD"
  | "BUILDING"
  | "PENDING_DEPLOY"
  | "DEPLOYING"
  | "ACTIVE"
  | "SUPERSEDED"
  | "ERROR"
  | "CANCELED";

export interface DigitalOceanDeployment {
  readonly id: string;
  readonly phase: DigitalOceanPhase | string;
}

export interface DigitalOceanAppClient {
  getApp(appId: string): Promise<{ readonly spec: DigitalOceanAppSpec }>;
  updateApp(appId: string, spec: DigitalOceanAppSpec): Promise<void>;
  createDeployment(appId: string): Promise<DigitalOceanDeployment>;
  getDeployment(appId: string, deploymentId: string): Promise<DigitalOceanDeployment>;
}

export interface DigitalOceanAppConfiguration {
  readonly appId: string;
  readonly service: string;
  readonly registryType: DigitalOceanRegistryType;
  readonly registry?: string;
  readonly repository: string;
  readonly deploymentUrl: string;
}

const digestPattern = /^sha256:[0-9a-f]{64}$/u;

function pinnedToDigest(artifact: ArtifactReference): boolean {
  if (!digestPattern.test(artifact.digest)) return false;
  const [repository, reference] = artifact.uri.split("@");
  return (
    repository !== undefined && repository.length > 0 &&
    !repository.includes(":") &&
    reference === artifact.digest
  );
}

export function createDigitalOceanAppAdapter(
  configuration: DigitalOceanAppConfiguration,
  client: DigitalOceanAppClient,
  now: () => Date = () => new Date(),
): DeploymentAdapter {
  let deploymentId: string | undefined;
  let expected: { readonly digest: string; readonly version: string } | undefined;

  async function pinAndDeploy(artifact: ArtifactReference, version: string): Promise<void> {
    if (!pinnedToDigest(artifact)) throw new Error("artifact is not pinned to its digest");
    const { spec } = await client.getApp(configuration.appId);
    const target = spec.services.find((service) => service.name === configuration.service);
    if (target === undefined) throw new Error("the app spec has no matching service");

    const updated: DigitalOceanAppSpec = {
      ...spec,
      services: spec.services.map((service) =>
        service.name === configuration.service
          ? {
            ...service,
            // `tag` is dropped deliberately: the published spec rejects a tag and a
            // digest together, and defaults to `latest` when neither is present.
            image: {
              registry_type: configuration.registryType,
              ...(configuration.registry === undefined ? {} : { registry: configuration.registry }),
              repository: configuration.repository,
              digest: artifact.digest,
            },
          }
          : service
      ),
    };
    await client.updateApp(configuration.appId, updated);
    const deployment = await client.createDeployment(configuration.appId);
    if (deployment.id.length === 0) throw new Error("digitalocean reported no deployment identity");
    deploymentId = deployment.id;
    expected = { digest: artifact.digest, version };
  }

  async function observe(): Promise<DigitalOceanDeployment> {
    if (deploymentId === undefined) {
      throw new Error("no deployment has been performed by this adapter");
    }
    return client.getDeployment(configuration.appId, deploymentId);
  }

  return {
    name: "digitalocean-app",

    async validate(manifest: DeploymentManifest): Promise<boolean> {
      if (!pinnedToDigest(manifest.artifact)) return false;
      if (manifest.previousArtifact !== null && !pinnedToDigest(manifest.previousArtifact)) return false;
      return true;
    },

    async deploy(artifact: ArtifactReference, manifest: DeploymentManifest): Promise<void> {
      await pinAndDeploy(artifact, manifest.verification.expectedVersion);
    },

    async rollback(previousArtifact: ArtifactReference): Promise<void> {
      await pinAndDeploy(previousArtifact, expected?.version ?? "");
    },

    async health(): Promise<boolean> {
      return (await observe()).phase === "ACTIVE";
    },

    async deploymentUrl(): Promise<string> {
      return configuration.deploymentUrl;
    },

    async deployedVersion(): Promise<string> {
      if (expected === undefined) throw new Error("no deployment has been performed by this adapter");
      const { spec } = await client.getApp(configuration.appId);
      const live = spec.services.find((service) => service.name === configuration.service)?.image.digest;
      if (live === undefined) throw new Error("the live app spec pins no image digest");
      // Reporting the live digest on a mismatch surfaces a version mismatch to the
      // orchestrator instead of silently claiming the intended version.
      return live === expected.digest ? expected.version : live;
    },

    async evidence() {
      const deployment = await observe();
      return { deploymentId: deployment.id, observedAt: now().toISOString() };
    },
  };
}
