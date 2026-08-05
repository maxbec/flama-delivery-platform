import { describe, expect, it } from "vitest";
import { createSchemaValidator } from "../../packages/contracts/src/schema-validator.js";
import { orchestrateDeployment, type DeploymentAdapter, type DeploymentManifest, type VerificationRunner } from "./orchestrator.js";

class FakeClock {
  current = new Date("2026-07-28T09:00:00.000Z");
  readonly waits: number[] = [];

  now(): Date {
    return new Date(this.current);
  }

  async wait(seconds: number): Promise<void> {
    this.waits.push(seconds);
    this.current = new Date(this.current.getTime() + seconds * 1_000);
  }
}

class FakeAdapter implements DeploymentAdapter {
  readonly name = "docker-compose" as const;
  deployCalls = 0;
  rollbackCalls = 0;
  currentVersion = "1.1.0";
  healthy = true;
  failRollback = false;

  async validate(): Promise<boolean> {
    return true;
  }

  async deploy(): Promise<void> {
    this.deployCalls += 1;
    this.currentVersion = "1.2.0";
  }

  async health(): Promise<boolean> {
    return this.healthy;
  }

  async rollback(): Promise<void> {
    this.rollbackCalls += 1;
    if (this.failRollback) throw new Error("simulated rollback failure");
    this.currentVersion = "1.1.0";
    this.healthy = true;
  }

  async deploymentUrl(): Promise<string> {
    return "https://example.invalid/health";
  }

  async deployedVersion(): Promise<string> {
    return this.currentVersion;
  }

  async evidence() {
    return { deploymentId: "deployment-1", observedAt: "2026-07-28T09:10:00.000Z" };
  }
}

class FakeVerification implements VerificationRunner {
  smokeCalls = 0;
  failOnCall: number | undefined;

  async smoke(): Promise<boolean> {
    this.smokeCalls += 1;
    return this.smokeCalls !== this.failOnCall;
  }
}

const manifest: DeploymentManifest = {
  version: "1.2.0",
  artifact: { uri: "ghcr.io/maxbec/api@sha256:new", digest: `sha256:${"a".repeat(64)}` },
  previousArtifact: { uri: "ghcr.io/maxbec/api@sha256:old", digest: `sha256:${"b".repeat(64)}` },
  verification: { expectedVersion: "1.2.0", soakSeconds: 600 },
  rollback: { automatic: true, attemptLimit: 1 },
};

describe("deployment orchestrator", () => {
  it("verifies immediately and throughout the ten-minute soak", async () => {
    const adapter = new FakeAdapter();
    const verification = new FakeVerification();
    const clock = new FakeClock();

    const result = await orchestrateDeployment({ manifest, adapter, verification, clock, intervalSeconds: 300 });

    expect(result.status).toBe("deployed");
    expect(result.rollbackAttempts).toBe(0);
    expect(result.checks).toHaveLength(3);
    expect(clock.waits).toEqual([300, 300]);
    expect(adapter.deployCalls).toBe(1);
    expect(adapter.rollbackCalls).toBe(0);
    const validator = await createSchemaValidator(new URL("../../", import.meta.url).pathname);
    expect(validator.validate("deployment-result", result)).toEqual({
      ok: true,
      schema: "deployment-result",
    });
  });

  it("rolls back exactly once when a soak smoke check fails", async () => {
    const adapter = new FakeAdapter();
    const verification = new FakeVerification();
    verification.failOnCall = 2;
    const clock = new FakeClock();

    const result = await orchestrateDeployment({ manifest, adapter, verification, clock, intervalSeconds: 300 });

    expect(result.status).toBe("rolled_back");
    expect(result.reasonCode).toBe("smoke_failed");
    expect(result.rollbackAttempts).toBe(1);
    expect(adapter.rollbackCalls).toBe(1);
    expect(adapter.currentVersion).toBe("1.1.0");
    expect(clock.waits).toEqual([300]);
  });

  it("never retries a failed rollback", async () => {
    const adapter = new FakeAdapter();
    adapter.healthy = false;
    adapter.failRollback = true;
    const verification = new FakeVerification();
    const clock = new FakeClock();

    const result = await orchestrateDeployment({ manifest, adapter, verification, clock, intervalSeconds: 300 });

    expect(result.status).toBe("rollback_failed");
    expect(result.rollbackAttempts).toBe(1);
    expect(adapter.rollbackCalls).toBe(1);
  });

  it("fails closed before deployment when soak or rollback policy is weakened", async () => {
    const adapter = new FakeAdapter();
    const verification = new FakeVerification();
    const clock = new FakeClock();
    const unsafeManifest = {
      ...manifest,
      verification: { ...manifest.verification, soakSeconds: 60 },
      rollback: { automatic: false, attemptLimit: 3 },
    };

    const result = await orchestrateDeployment({
      manifest: unsafeManifest,
      adapter,
      verification,
      clock,
      intervalSeconds: 30,
    });

    expect(result.status).toBe("failed");
    expect(result.reasonCode).toBe("unsafe_deployment_policy");
    expect(adapter.deployCalls).toBe(0);
    expect(adapter.rollbackCalls).toBe(0);
  });
});
