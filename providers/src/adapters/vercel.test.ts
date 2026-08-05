import { describe, expect, it } from "vitest";
import type { DeploymentManifest } from "../orchestrator.js";
import type { CommandResult, CommandRunner } from "./docker-compose.js";
import {
  createVercelAdapter,
  type VercelDeployment,
  type VercelDeploymentReader,
} from "./vercel.js";

const digest = `sha256:${"1".repeat(64)}`;
const previousDigest = `sha256:${"2".repeat(64)}`;

const manifest: DeploymentManifest = {
  version: "2.1.0",
  artifact: { uri: ".vercel/output", digest },
  previousArtifact: { uri: "https://app-abc123.vercel.app", digest: previousDigest },
  verification: { expectedVersion: "2.1.0", soakSeconds: 600 },
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
    return this.results.shift() ?? { code: 0, stdout: "https://app-def456.vercel.app\n" };
  }
}

class FakeReader implements VercelDeploymentReader {
  readonly reads: string[] = [];
  deployment: VercelDeployment = {
    url: "app-def456.vercel.app",
    readyState: "READY",
    target: "production",
    meta: { flamaVersion: "2.1.0" },
  };

  async read(idOrUrl: string): Promise<VercelDeployment> {
    this.reads.push(idOrUrl);
    return this.deployment;
  }
}

function adapter(runner: CommandRunner, reader: VercelDeploymentReader) {
  return createVercelAdapter(
    { projectId: "prj_abc123", deploymentUrl: "https://app.example.test", scope: "flama" },
    runner,
    reader,
    { reveal: () => "test-only-vercel-token" },
    () => new Date("2026-07-30T14:00:00.000Z"),
  );
}

describe("vercel prebuilt validation", () => {
  it("identifies itself as the vercel-prebuilt provider", () => {
    expect(adapter(new RecordingRunner(), new FakeReader()).name).toBe("vercel-prebuilt");
  });

  it("accepts a digest-bound prebuilt output directory", async () => {
    await expect(adapter(new RecordingRunner(), new FakeReader()).validate(manifest)).resolves.toBe(true);
  });

  it("rejects an artifact without a full sha256 digest", async () => {
    await expect(adapter(new RecordingRunner(), new FakeReader()).validate({
      ...manifest,
      artifact: { uri: ".vercel/output", digest: "sha256:short" },
    })).resolves.toBe(false);
  });

  it("rejects a container reference, because this provider deploys prebuilt output", async () => {
    await expect(adapter(new RecordingRunner(), new FakeReader()).validate({
      ...manifest,
      artifact: { uri: "ghcr.io/maxbec/api:latest", digest },
    })).resolves.toBe(false);
  });

  it("requires the rollback target to be a previous https deployment URL", async () => {
    await expect(adapter(new RecordingRunner(), new FakeReader()).validate({
      ...manifest,
      previousArtifact: { uri: "app-abc123.vercel.app", digest: previousDigest },
    })).resolves.toBe(false);
  });
});

describe("vercel prebuilt deployment", () => {
  it("uploads prebuilt output to production without building and records the version", async () => {
    const runner = new RecordingRunner();

    await adapter(runner, new FakeReader()).deploy(manifest.artifact, manifest);

    expect(runner.calls[0]).toEqual({
      command: "vercel",
      args: [
        "deploy",
        "--prebuilt",
        "--prod",
        "--non-interactive",
        "--archive=tgz",
        "--meta",
        "flamaVersion=2.1.0",
        "--scope",
        "flama",
      ],
    });
  });

  it("passes the token through the environment, never the argument list", async () => {
    const runner = new RecordingRunner();

    await adapter(runner, new FakeReader()).deploy(manifest.artifact, manifest);

    expect(runner.environments[0]).toEqual({ VERCEL_TOKEN: "test-only-vercel-token" });
    expect(runner.calls.flatMap((call) => call.args).join(" ")).not.toContain("test-only-vercel-token");
  });

  it("fails closed when the deploy command does not succeed", async () => {
    const runner = new RecordingRunner();
    runner.results = [{ code: 1, stdout: "" }];

    await expect(adapter(runner, new FakeReader()).deploy(manifest.artifact, manifest)).rejects.toThrow();
  });

  it("fails closed when stdout is not a deployment URL", async () => {
    const runner = new RecordingRunner();
    runner.results = [{ code: 0, stdout: "Deploying...\n" }];

    await expect(adapter(runner, new FakeReader()).deploy(manifest.artifact, manifest)).rejects.toThrow();
  });

  it("performs an instant rollback to the previous deployment URL", async () => {
    const runner = new RecordingRunner();

    await adapter(runner, new FakeReader()).rollback(manifest.previousArtifact as never);

    expect(runner.calls[0]).toEqual({
      command: "vercel",
      args: ["rollback", "https://app-abc123.vercel.app", "--non-interactive", "--scope", "flama"],
    });
    expect(runner.environments[0]).toEqual({ VERCEL_TOKEN: "test-only-vercel-token" });
  });
});

describe("vercel prebuilt verification", () => {
  it("reads health back from Vercel rather than assuming the deploy succeeded", async () => {
    const runner = new RecordingRunner();
    const reader = new FakeReader();
    const vercel = adapter(runner, reader);

    await vercel.deploy(manifest.artifact, manifest);

    await expect(vercel.health()).resolves.toBe(true);
    expect(reader.reads).toEqual(["https://app-def456.vercel.app"]);
  });

  it("reports unhealthy while the deployment has not reached READY", async () => {
    const reader = new FakeReader();
    reader.deployment = { ...reader.deployment, readyState: "BUILDING" };
    const vercel = adapter(new RecordingRunner(), reader);

    await vercel.deploy(manifest.artifact, manifest);

    await expect(vercel.health()).resolves.toBe(false);
  });

  it("reports unhealthy when the deployment is not the production target", async () => {
    const reader = new FakeReader();
    reader.deployment = { ...reader.deployment, target: "staging" };
    const vercel = adapter(new RecordingRunner(), reader);

    await vercel.deploy(manifest.artifact, manifest);

    await expect(vercel.health()).resolves.toBe(false);
  });

  it("reads the deployed version from the version Vercel recorded", async () => {
    const reader = new FakeReader();
    const vercel = adapter(new RecordingRunner(), reader);

    await vercel.deploy(manifest.artifact, manifest);

    await expect(vercel.deployedVersion()).resolves.toBe("2.1.0");
  });

  it("fails closed when Vercel records no version for the deployment", async () => {
    const reader = new FakeReader();
    reader.deployment = { ...reader.deployment, meta: {} };
    const vercel = adapter(new RecordingRunner(), reader);

    await vercel.deploy(manifest.artifact, manifest);

    await expect(vercel.deployedVersion()).rejects.toThrow();
  });

  it("refuses to verify before a deployment or rollback has been performed", async () => {
    const vercel = adapter(new RecordingRunner(), new FakeReader());

    await expect(vercel.deployedVersion()).rejects.toThrow();
  });

  it("reports the deployment identity and observation time as evidence", async () => {
    const vercel = adapter(new RecordingRunner(), new FakeReader());

    await vercel.deploy(manifest.artifact, manifest);

    await expect(vercel.evidence()).resolves.toEqual({
      deploymentId: "app-def456.vercel.app",
      observedAt: "2026-07-30T14:00:00.000Z",
    });
  });

  it("reports the configured production URL as the deployment URL", async () => {
    await expect(adapter(new RecordingRunner(), new FakeReader()).deploymentUrl())
      .resolves.toBe("https://app.example.test");
  });
});
