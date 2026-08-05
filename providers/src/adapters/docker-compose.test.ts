import { describe, expect, it } from "vitest";
import type { DeploymentManifest } from "../orchestrator.js";
import {
  createDockerComposeAdapter,
  createDockerHostAdapter,
  type CommandRunner,
  type CommandResult,
} from "./docker-compose.js";

const digest = `sha256:${"c".repeat(64)}`;
const previousDigest = `sha256:${"d".repeat(64)}`;

const manifest: DeploymentManifest = {
  version: "1.4.0",
  artifact: { uri: `ghcr.io/maxbec/api@${digest}`, digest },
  previousArtifact: { uri: `ghcr.io/maxbec/api@${previousDigest}`, digest: previousDigest },
  verification: { expectedVersion: "1.4.0", soakSeconds: 600 },
  rollback: { automatic: true, attemptLimit: 1 },
};

class RecordingRunner implements CommandRunner {
  readonly calls: { command: string; args: readonly string[] }[] = [];
  readonly environments: (Readonly<Record<string, string>> | undefined)[] = [];
  results: CommandResult[] = [];

  async run(
    command: string,
    args: readonly string[],
    environment?: Readonly<Record<string, string>>,
  ): Promise<CommandResult> {
    this.calls.push({ command, args });
    this.environments.push(environment);
    return this.results.shift() ?? { code: 0, stdout: "" };
  }
}

function adapter(runner: CommandRunner) {
  return createDockerComposeAdapter({
    composeFile: "deploy/compose.yaml",
    projectName: "flama-api",
    service: "api",
    deploymentUrl: "https://api.example.test",
  }, runner);
}

describe("docker compose adapter validation", () => {
  it("identifies itself as the docker-compose provider", () => {
    expect(adapter(new RecordingRunner()).name).toBe("docker-compose");
  });

  it("accepts a digest-pinned artifact without contacting docker", async () => {
    const runner = new RecordingRunner();

    await expect(adapter(runner).validate(manifest)).resolves.toBe(true);
    expect(runner.calls).toEqual([]);
  });

  it("rejects an artifact reference that is not pinned to its digest", async () => {
    const runner = new RecordingRunner();
    const unpinned: DeploymentManifest = {
      ...manifest,
      artifact: { uri: "ghcr.io/maxbec/api:1.4.0", digest },
    };

    await expect(adapter(runner).validate(unpinned)).resolves.toBe(false);
    expect(runner.calls).toEqual([]);
  });

  it("rejects a mutable latest tag", async () => {
    const unpinned: DeploymentManifest = {
      ...manifest,
      artifact: { uri: "ghcr.io/maxbec/api:latest", digest },
    };

    await expect(adapter(new RecordingRunner()).validate(unpinned)).resolves.toBe(false);
  });

  it("rejects an artifact whose reference digest contradicts the recorded digest", async () => {
    const mismatched: DeploymentManifest = {
      ...manifest,
      artifact: { uri: `ghcr.io/maxbec/api@${previousDigest}`, digest },
    };

    await expect(adapter(new RecordingRunner()).validate(mismatched)).resolves.toBe(false);
  });

  it("rejects a rollback-capable manifest whose previous artifact is unpinned", async () => {
    const mixed: DeploymentManifest = {
      ...manifest,
      previousArtifact: { uri: "ghcr.io/maxbec/api:previous", digest: previousDigest },
    };

    await expect(adapter(new RecordingRunner()).validate(mixed)).resolves.toBe(false);
  });
});

describe("docker compose deployment", () => {
  it("pulls the exact digest and starts the service without building source", async () => {
    const runner = new RecordingRunner();

    await adapter(runner).deploy(manifest.artifact, manifest);

    expect(runner.calls).toEqual([
      { command: "docker", args: ["pull", `ghcr.io/maxbec/api@${digest}`] },
      {
        command: "docker",
        args: [
          "compose",
          "--file",
          "deploy/compose.yaml",
          "--project-name",
          "flama-api",
          "up",
          "--detach",
          "--no-build",
          "api",
        ],
      },
    ]);
    expect(runner.calls.flatMap((call) => call.args)).not.toContain("build");
  });

  it("passes the pinned reference to compose through the environment, never the source tree", async () => {
    const runner = new RecordingRunner();

    await adapter(runner).deploy(manifest.artifact, manifest);

    expect(runner.environments[1]).toEqual({ FLAMA_IMAGE: `ghcr.io/maxbec/api@${digest}` });
  });

  it("refuses to deploy an artifact that is not pinned to its digest", async () => {
    const runner = new RecordingRunner();

    await expect(
      adapter(runner).deploy({ uri: "ghcr.io/maxbec/api:latest", digest }, manifest),
    ).rejects.toThrow();
    expect(runner.calls).toEqual([]);
  });

  it("fails closed when the pull does not succeed", async () => {
    const runner = new RecordingRunner();
    runner.results = [{ code: 1, stdout: "" }];

    await expect(adapter(runner).deploy(manifest.artifact, manifest)).rejects.toThrow();
    expect(runner.calls).toHaveLength(1);
  });

  it("restores the previous digest through the same pinned path", async () => {
    const runner = new RecordingRunner();

    await adapter(runner).rollback(manifest.previousArtifact as never);

    expect(runner.calls[0]).toEqual({
      command: "docker",
      args: ["pull", `ghcr.io/maxbec/api@${previousDigest}`],
    });
    expect(runner.environments[1]).toEqual({ FLAMA_IMAGE: `ghcr.io/maxbec/api@${previousDigest}` });
  });
});

const psLine = JSON.stringify({
  ID: "9f1c2d3e4b5a",
  Name: "flama-api-api-1",
  Service: "api",
  Image: `ghcr.io/maxbec/api@${digest}`,
  State: "running",
  Health: "healthy",
});

function observedAdapter(runner: CommandRunner) {
  return createDockerComposeAdapter(
    {
      composeFile: "deploy/compose.yaml",
      projectName: "flama-api",
      service: "api",
      deploymentUrl: "https://api.example.test",
    },
    runner,
    () => new Date("2026-07-30T12:00:00.000Z"),
  );
}

describe("docker compose observation", () => {
  it("reports healthy only when the service is running and its healthcheck passes", async () => {
    const runner = new RecordingRunner();
    runner.results = [{ code: 0, stdout: psLine }];

    await expect(observedAdapter(runner).health()).resolves.toBe(true);
    expect(runner.calls[0]?.args).toEqual([
      "compose",
      "--file",
      "deploy/compose.yaml",
      "--project-name",
      "flama-api",
      "ps",
      "--format",
      "json",
      "api",
    ]);
  });

  it("reports unhealthy when the container runs without a passing healthcheck", async () => {
    const runner = new RecordingRunner();
    runner.results = [{ code: 0, stdout: JSON.stringify({ ...JSON.parse(psLine), Health: "" }) }];

    await expect(observedAdapter(runner).health()).resolves.toBe(false);
  });

  it("reports unhealthy when the service is not running", async () => {
    const runner = new RecordingRunner();
    runner.results = [{ code: 0, stdout: JSON.stringify({ ...JSON.parse(psLine), State: "exited" }) }];

    await expect(observedAdapter(runner).health()).resolves.toBe(false);
  });

  it("reports unhealthy rather than throwing when compose reports nothing", async () => {
    const runner = new RecordingRunner();
    runner.results = [{ code: 0, stdout: "" }];

    await expect(observedAdapter(runner).health()).resolves.toBe(false);
  });

  it("accepts a compose build that emits a JSON array instead of one object per line", async () => {
    const runner = new RecordingRunner();
    runner.results = [{ code: 0, stdout: `[${psLine}]` }];

    await expect(observedAdapter(runner).health()).resolves.toBe(true);
  });

  it("reads the deployed version from the running image's OCI version label", async () => {
    const runner = new RecordingRunner();
    runner.results = [
      { code: 0, stdout: psLine },
      { code: 0, stdout: "1.4.0\n" },
    ];

    await expect(observedAdapter(runner).deployedVersion()).resolves.toBe("1.4.0");
    expect(runner.calls[1]).toEqual({
      command: "docker",
      args: [
        "image",
        "inspect",
        `ghcr.io/maxbec/api@${digest}`,
        "--format",
        '{{index .Config.Labels "org.opencontainers.image.version"}}',
      ],
    });
  });

  it("fails closed when the image carries no version label", async () => {
    const runner = new RecordingRunner();
    runner.results = [
      { code: 0, stdout: psLine },
      { code: 0, stdout: "\n" },
    ];

    await expect(observedAdapter(runner).deployedVersion()).rejects.toThrow();
  });

  it("returns the container identity and the observation time as evidence", async () => {
    const runner = new RecordingRunner();
    runner.results = [{ code: 0, stdout: psLine }];

    await expect(observedAdapter(runner).evidence()).resolves.toEqual({
      deploymentId: "9f1c2d3e4b5a",
      observedAt: "2026-07-30T12:00:00.000Z",
    });
  });

  it("fails closed when evidence cannot identify the running container", async () => {
    const runner = new RecordingRunner();
    runner.results = [{ code: 0, stdout: "" }];

    await expect(observedAdapter(runner).evidence()).rejects.toThrow();
  });
});

describe("remote docker host providers", () => {
  function remote(provider: "digitalocean-droplet" | "hostinger-vps", runner: CommandRunner) {
    return createDockerHostAdapter(
      {
        provider,
        composeFile: "deploy/compose.yaml",
        projectName: "flama-api",
        service: "api",
        deploymentUrl: "https://api.example.test",
        dockerHost: "ssh://deploy@droplet.example.test",
      },
      runner,
      () => new Date("2026-07-30T12:00:00.000Z"),
    );
  }

  it("presents itself as the droplet provider, not as docker-compose", () => {
    expect(remote("digitalocean-droplet", new RecordingRunner()).name).toBe("digitalocean-droplet");
  });

  it("presents itself as the hostinger provider", () => {
    expect(remote("hostinger-vps", new RecordingRunner()).name).toBe("hostinger-vps");
  });

  it("directs every docker invocation at the remote host", async () => {
    const runner = new RecordingRunner();

    await remote("digitalocean-droplet", runner).deploy(manifest.artifact, manifest);

    expect(runner.environments).toEqual([
      { DOCKER_HOST: "ssh://deploy@droplet.example.test" },
      { DOCKER_HOST: "ssh://deploy@droplet.example.test", FLAMA_IMAGE: `ghcr.io/maxbec/api@${digest}` },
    ]);
  });

  it("keeps the remote host bound while observing health", async () => {
    const runner = new RecordingRunner();
    runner.results = [{ code: 0, stdout: psLine }];

    await expect(remote("hostinger-vps", runner).health()).resolves.toBe(true);
    expect(runner.environments[0]).toEqual({ DOCKER_HOST: "ssh://deploy@droplet.example.test" });
  });

  it("leaves a local docker-compose deployment without a docker host override", async () => {
    const runner = new RecordingRunner();

    await adapter(runner).deploy(manifest.artifact, manifest);

    expect(runner.environments[0]).toBeUndefined();
  });
});
