import { describe, expect, it } from "vitest";
import type { DeploymentManifest } from "../orchestrator.js";
import {
  createDigitalOceanAppAdapter,
  type DigitalOceanAppClient,
  type DigitalOceanAppSpec,
  type DigitalOceanDeployment,
} from "./digitalocean-app.js";

const digest = `sha256:${"3".repeat(64)}`;
const previousDigest = `sha256:${"4".repeat(64)}`;

const manifest: DeploymentManifest = {
  version: "3.2.0",
  artifact: { uri: `ghcr.io/maxbec/api@${digest}`, digest },
  previousArtifact: { uri: `ghcr.io/maxbec/api@${previousDigest}`, digest: previousDigest },
  verification: { expectedVersion: "3.2.0", soakSeconds: 600 },
  rollback: { automatic: true, attemptLimit: 1 },
};

class FakeClient implements DigitalOceanAppClient {
  spec: DigitalOceanAppSpec = {
    name: "flama-api",
    services: [
      {
        name: "api",
        image: {
          registry_type: "GHCR",
          registry: "maxbec",
          repository: "api",
          tag: "latest",
        },
      },
    ],
  };
  deployment: DigitalOceanDeployment = { id: "dep-1", phase: "ACTIVE" };
  readonly updates: DigitalOceanAppSpec[] = [];
  createdDeployments = 0;

  async getApp(): Promise<{ spec: DigitalOceanAppSpec }> {
    return { spec: this.spec };
  }

  async updateApp(_appId: string, spec: DigitalOceanAppSpec): Promise<void> {
    this.updates.push(spec);
    this.spec = spec;
  }

  async createDeployment(): Promise<DigitalOceanDeployment> {
    this.createdDeployments += 1;
    return this.deployment;
  }

  async getDeployment(): Promise<DigitalOceanDeployment> {
    return this.deployment;
  }
}

function adapter(client: DigitalOceanAppClient) {
  return createDigitalOceanAppAdapter(
    {
      appId: "abc-123",
      service: "api",
      registryType: "GHCR",
      registry: "maxbec",
      repository: "api",
      deploymentUrl: "https://api.example.test",
    },
    client,
    () => new Date("2026-07-30T15:00:00.000Z"),
  );
}

describe("digitalocean app validation", () => {
  it("identifies itself as the digitalocean-app provider", () => {
    expect(adapter(new FakeClient()).name).toBe("digitalocean-app");
  });

  it("accepts a digest-pinned artifact", async () => {
    await expect(adapter(new FakeClient()).validate(manifest)).resolves.toBe(true);
  });

  it("rejects a mutable tag reference", async () => {
    await expect(adapter(new FakeClient()).validate({
      ...manifest,
      artifact: { uri: "ghcr.io/maxbec/api:latest", digest },
    })).resolves.toBe(false);
  });

  it("rejects a digest that contradicts the reference", async () => {
    await expect(adapter(new FakeClient()).validate({
      ...manifest,
      artifact: { uri: `ghcr.io/maxbec/api@${previousDigest}`, digest },
    })).resolves.toBe(false);
  });
});

describe("digitalocean app deployment", () => {
  it("pins the service image to the exact digest and drops any tag", async () => {
    const client = new FakeClient();

    await adapter(client).deploy(manifest.artifact, manifest);

    const image = client.updates[0]?.services[0]?.image;
    expect(image).toEqual({
      registry_type: "GHCR",
      registry: "maxbec",
      repository: "api",
      digest,
    });
    expect(image).not.toHaveProperty("tag");
  });

  it("creates exactly one deployment after updating the spec", async () => {
    const client = new FakeClient();

    await adapter(client).deploy(manifest.artifact, manifest);

    expect(client.updates).toHaveLength(1);
    expect(client.createdDeployments).toBe(1);
  });

  it("refuses to deploy when the app has no matching service", async () => {
    const client = new FakeClient();
    client.spec = { name: "flama-api", services: [{ name: "worker", image: { registry_type: "GHCR", registry: "maxbec", repository: "api", tag: "latest" } }] };

    await expect(adapter(client).deploy(manifest.artifact, manifest)).rejects.toThrow();
    expect(client.createdDeployments).toBe(0);
  });

  it("refuses to deploy an artifact that is not digest pinned", async () => {
    const client = new FakeClient();

    await expect(adapter(client).deploy({ uri: "ghcr.io/maxbec/api:latest", digest }, manifest))
      .rejects.toThrow();
    expect(client.updates).toHaveLength(0);
  });

  it("restores the previous digest through the same pinned path", async () => {
    const client = new FakeClient();
    const app = adapter(client);
    await app.deploy(manifest.artifact, manifest);

    await app.rollback(manifest.previousArtifact as never);

    expect(client.updates[1]?.services[0]?.image.digest).toBe(previousDigest);
    expect(client.createdDeployments).toBe(2);
  });
});

describe("digitalocean app verification", () => {
  it("reports healthy only for the ACTIVE phase", async () => {
    const client = new FakeClient();
    const app = adapter(client);
    await app.deploy(manifest.artifact, manifest);

    await expect(app.health()).resolves.toBe(true);
  });

  it("reports unhealthy for every non-terminal or failed phase", async () => {
    for (const phase of ["PENDING_BUILD", "BUILDING", "PENDING_DEPLOY", "DEPLOYING", "SUPERSEDED", "ERROR", "CANCELED", "UNKNOWN"]) {
      const client = new FakeClient();
      client.deployment = { id: "dep-1", phase };
      const app = adapter(client);
      await app.deploy(manifest.artifact, manifest);

      await expect(app.health()).resolves.toBe(false);
    }
  });

  it("reads the live digest back from the app spec rather than trusting the deploy", async () => {
    const client = new FakeClient();
    const app = adapter(client);
    await app.deploy(manifest.artifact, manifest);

    await expect(app.deployedVersion()).resolves.toBe("3.2.0");
  });

  it("reports the live digest instead of the version when the app serves something else", async () => {
    const client = new FakeClient();
    const app = adapter(client);
    await app.deploy(manifest.artifact, manifest);
    // Something outside the platform re-pointed the app after deployment.
    client.spec = {
      ...client.spec,
      services: [{ ...client.spec.services[0]!, image: { registry_type: "GHCR", registry: "maxbec", repository: "api", digest: previousDigest } }],
    };

    await expect(app.deployedVersion()).resolves.toBe(previousDigest);
  });

  it("refuses to verify before a deployment has been performed", async () => {
    await expect(adapter(new FakeClient()).health()).rejects.toThrow();
  });

  it("reports the deployment identity and observation time as evidence", async () => {
    const client = new FakeClient();
    const app = adapter(client);
    await app.deploy(manifest.artifact, manifest);

    await expect(app.evidence()).resolves.toEqual({
      deploymentId: "dep-1",
      observedAt: "2026-07-30T15:00:00.000Z",
    });
  });
});
