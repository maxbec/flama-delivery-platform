import { describe, expect, it } from "vitest";
import { createSchemaValidator } from "../../packages/contracts/src/schema-validator.js";
import type { DeploymentAdapter, VerificationRunner } from "./orchestrator.js";
import { executeRollback, planRollback, RollbackError, type RollbackInput } from "./rollback.js";

class FakeClock {
  current = new Date("2026-07-30T09:00:00.000Z");
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
  currentVersion = "1.2.0";
  healthy = true;
  failRollback = false;

  async validate(): Promise<boolean> {
    return true;
  }

  async deploy(): Promise<void> {
    this.deployCalls += 1;
  }

  async health(): Promise<boolean> {
    return this.healthy;
  }

  async rollback(): Promise<void> {
    this.rollbackCalls += 1;
    if (this.failRollback) throw new Error("simulated rollback failure");
    this.currentVersion = "1.1.0";
  }

  async deploymentUrl(): Promise<string> {
    return "https://example.invalid/health";
  }

  async deployedVersion(): Promise<string> {
    return this.currentVersion;
  }

  async evidence() {
    return { deploymentId: "rollback-1", observedAt: "2026-07-30T09:10:00.000Z" };
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

const currentDigest = `sha256:${"a".repeat(64)}`;
const targetDigest = `sha256:${"b".repeat(64)}`;

const input: RollbackInput = {
  schemaVersion: 1,
  provider: { name: "docker-compose" },
  current: {
    version: "1.2.0",
    artifact: { uri: "ghcr.io/maxbec/api@sha256:new", digest: currentDigest },
  },
  target: {
    version: "1.1.0",
    artifact: { uri: "ghcr.io/maxbec/api@sha256:old", digest: targetDigest },
  },
  verification: { expectedVersion: "1.1.0", soakSeconds: 600 },
  migration: { rollbackCompatible: true },
  authorization: { drill: false, incidentRef: "PRI-900" },
};

describe("rollback planning", () => {
  it("plans a restore of the previous immutable artifact without contacting the provider", () => {
    expect(planRollback(input)).toEqual({
      schemaVersion: 1,
      status: "planned",
      provider: "docker-compose",
      restoredDigest: targetDigest,
      supersededDigest: currentDigest,
      drill: false,
      attempts: 0,
      checks: [],
    });
  });
});

function expectRejection(patch: Partial<RollbackInput>, code: string): void {
  let thrown: unknown;
  try {
    planRollback({ ...input, ...patch });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RollbackError);
  expect((thrown as RollbackError).code).toBe(code);
}

describe("rollback preconditions", () => {
  it("rejects a target that is already the deployed artifact", () => {
    expectRejection({ target: { ...input.target, artifact: input.current.artifact } }, "rollback_target_invalid");
  });

  it("rejects a mutable target artifact reference", () => {
    expectRejection(
      { target: { ...input.target, artifact: { uri: "ghcr.io/maxbec/api:latest", digest: targetDigest } } },
      "rollback_target_invalid",
    );
  });

  it("rejects a target digest that is not a full sha256 digest", () => {
    expectRejection(
      { target: { ...input.target, artifact: { uri: "ghcr.io/maxbec/api@sha256:old", digest: "sha256:abc" } } },
      "rollback_target_invalid",
    );
  });

  it("rejects verification bound to a version other than the restored one", () => {
    expectRejection({ verification: { expectedVersion: "1.2.0", soakSeconds: 600 } }, "rollback_verification_invalid");
  });

  it("rejects a soak window shorter than ten minutes", () => {
    expectRejection({ verification: { expectedVersion: "1.1.0", soakSeconds: 599 } }, "rollback_verification_invalid");
  });

  it("rejects a rollback the migration cannot support", () => {
    expectRejection({ migration: { rollbackCompatible: false } }, "rollback_migration_incompatible");
  });

  it("rejects a non-drill rollback without an incident reference", () => {
    expectRejection({ authorization: { drill: false, incidentRef: null } }, "rollback_unauthorized");
  });

  it("plans a drill without requiring an incident reference", () => {
    const result = planRollback({ ...input, authorization: { drill: true, incidentRef: null } });

    expect(result.status).toBe("planned");
    expect(result.drill).toBe(true);
  });
});

describe("rollback execution", () => {
  it("restores the target artifact and verifies it across the soak window", async () => {
    const adapter = new FakeAdapter();
    const verification = new FakeVerification();
    const clock = new FakeClock();

    const result = await executeRollback({ input, adapter, verification, clock, intervalSeconds: 300 });

    expect(result.status).toBe("restored");
    expect(result.attempts).toBe(1);
    expect(result.restoredDigest).toBe(targetDigest);
    expect(result.checks).toHaveLength(3);
    expect(result.checks.map((check) => check.phase)).toEqual(["immediate", "soak", "soak"]);
    expect(clock.waits).toEqual([300, 300]);
    expect(adapter.rollbackCalls).toBe(1);
    expect(adapter.deployCalls).toBe(0);
    expect(result.startedAt).toBe("2026-07-30T09:00:00.000Z");
    expect(result.finishedAt).toBe("2026-07-30T09:10:00.000Z");
    expect(result.providerEvidence).toEqual({
      deploymentId: "rollback-1",
      observedAt: "2026-07-30T09:10:00.000Z",
    });
  });

  it("never attempts a second restore when the restored artifact is unhealthy", async () => {
    const adapter = new FakeAdapter();
    adapter.healthy = false;
    const verification = new FakeVerification();
    const clock = new FakeClock();

    const result = await executeRollback({ input, adapter, verification, clock, intervalSeconds: 300 });

    expect(result.status).toBe("failed");
    expect(result.reasonCode).toBe("health_failed");
    expect(result.attempts).toBe(1);
    expect(adapter.rollbackCalls).toBe(1);
    expect(clock.waits).toEqual([]);
  });

  it("reports a failed restore when the provider rejects it", async () => {
    const adapter = new FakeAdapter();
    adapter.failRollback = true;
    const verification = new FakeVerification();
    const clock = new FakeClock();

    const result = await executeRollback({ input, adapter, verification, clock, intervalSeconds: 300 });

    expect(result.status).toBe("failed");
    expect(result.reasonCode).toBe("rollback_failed");
    expect(result.attempts).toBe(1);
    expect(adapter.rollbackCalls).toBe(1);
  });

  it("fails closed when the restored deployment reports the superseded version", async () => {
    const adapter = new FakeAdapter();
    const verification = new FakeVerification();
    const clock = new FakeClock();

    const result = await executeRollback({
      input: { ...input, target: { ...input.target, version: "1.0.9" }, verification: { expectedVersion: "1.0.9", soakSeconds: 600 } },
      adapter,
      verification,
      clock,
      intervalSeconds: 300,
    });

    expect(result.status).toBe("failed");
    expect(result.reasonCode).toBe("version_mismatch");
    expect(result.attempts).toBe(1);
  });

  it("refuses to run against an adapter for a different provider", async () => {
    const adapter = new FakeAdapter();
    const verification = new FakeVerification();
    const clock = new FakeClock();

    await expect(executeRollback({
      input: { ...input, provider: { name: "render" } },
      adapter,
      verification,
      clock,
      intervalSeconds: 300,
    })).rejects.toMatchObject({ code: "rollback_provider_mismatch" });
    expect(adapter.rollbackCalls).toBe(0);
  });

  it("refuses an unsafe rollback before contacting the provider", async () => {
    const adapter = new FakeAdapter();
    const verification = new FakeVerification();
    const clock = new FakeClock();

    await expect(executeRollback({
      input: { ...input, migration: { rollbackCompatible: false } },
      adapter,
      verification,
      clock,
      intervalSeconds: 300,
    })).rejects.toMatchObject({ code: "rollback_migration_incompatible" });
    expect(adapter.rollbackCalls).toBe(0);
  });
});

describe("rollback evidence integrity", () => {
  it("fails closed when verification itself errors", async () => {
    const adapter = new FakeAdapter();
    adapter.health = async () => {
      throw new Error("simulated health probe crash");
    };
    const clock = new FakeClock();

    const result = await executeRollback({
      input,
      adapter,
      verification: new FakeVerification(),
      clock,
      intervalSeconds: 300,
    });

    expect(result.status).toBe("failed");
    expect(result.reasonCode).toBe("rollback_verification_error");
    expect(result.attempts).toBe(1);
  });

  it("rejects provider evidence without a deployment identifier", async () => {
    const adapter = new FakeAdapter();
    adapter.evidence = async () => ({ deploymentId: "", observedAt: "2026-07-30T09:10:00.000Z" });
    const clock = new FakeClock();

    const result = await executeRollback({
      input,
      adapter,
      verification: new FakeVerification(),
      clock,
      intervalSeconds: 300,
    });

    expect(result.status).toBe("failed");
    expect(result.reasonCode).toBe("invalid_provider_evidence");
  });

  it("refuses a soak interval longer than the soak window", async () => {
    const adapter = new FakeAdapter();

    await expect(executeRollback({
      input,
      adapter,
      verification: new FakeVerification(),
      clock: new FakeClock(),
      intervalSeconds: 601,
    })).rejects.toMatchObject({ code: "rollback_verification_invalid" });
    expect(adapter.rollbackCalls).toBe(0);
  });
});

describe("rollback contract", () => {
  it("emits planned and restored evidence that satisfies the published schemas", async () => {
    const validator = await createSchemaValidator(new URL("../../", import.meta.url).pathname);

    expect(validator.validate("rollback-input", input)).toEqual({ ok: true, schema: "rollback-input" });
    expect(validator.validate("rollback-result", planRollback(input))).toEqual({
      ok: true,
      schema: "rollback-result",
    });

    const restored = await executeRollback({
      input,
      adapter: new FakeAdapter(),
      verification: new FakeVerification(),
      clock: new FakeClock(),
      intervalSeconds: 300,
    });

    expect(restored.status).toBe("restored");
    expect(validator.validate("rollback-result", restored)).toEqual({ ok: true, schema: "rollback-result" });
  });

  it("rejects an input whose target artifact is a mutable tag", async () => {
    const validator = await createSchemaValidator(new URL("../../", import.meta.url).pathname);

    expect(validator.validate("rollback-input", {
      ...input,
      target: { ...input.target, artifact: { uri: "ghcr.io/maxbec/api:latest", digest: targetDigest } },
    }).ok).toBe(false);
  });
});
