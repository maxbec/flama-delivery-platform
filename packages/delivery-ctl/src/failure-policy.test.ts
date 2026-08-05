import { describe, expect, it } from "vitest";
import { decideFailureResponse, FailurePolicyError, type FailureObservation } from "./failure-policy.js";

const observation = (patch: Partial<FailureObservation> = {}): FailureObservation => ({
  schemaVersion: 1,
  stage: "preflight",
  classification: "deterministic",
  signature: `sha256:${"e".repeat(64)}`,
  attempt: 1,
  recentSameSignatureFailures: 0,
  ...patch,
});

describe("deterministic failure response", () => {
  it("never retries a deterministic build or test failure and opens a repair task", () => {
    const decision = decideFailureResponse(observation(), () => 0.5);

    expect(decision).toMatchObject({
      retry: "denied",
      retryDelaySeconds: null,
      followUp: "repair_task",
      incident: "none",
      releasePath: "open",
      notifyOwner: false,
    });
  });

  it("retries a recognized transient failure exactly once", () => {
    const decision = decideFailureResponse(
      observation({ classification: "transient_infrastructure" }),
      () => 0.5,
    );

    expect(decision.retry).toBe("allowed");
    expect(decision.followUp).toBe("none");
  });

  it("refuses a second retry of the same transient failure", () => {
    const decision = decideFailureResponse(
      observation({ classification: "transient_infrastructure", attempt: 2 }),
      () => 0.5,
    );

    expect(decision.retry).toBe("denied");
    expect(decision.retryDelaySeconds).toBeNull();
  });

  it("spreads the single transient retry with bounded jitter", () => {
    const floor = decideFailureResponse(
      observation({ classification: "transient_infrastructure" }),
      () => 0,
    );
    const ceiling = decideFailureResponse(
      observation({ classification: "transient_infrastructure" }),
      () => 0.999_999,
    );

    expect(floor.retryDelaySeconds).toBe(5);
    expect(ceiling.retryDelaySeconds).toBe(35);
  });

  it("retries a flaky test once and always records a stabilization task", () => {
    const decision = decideFailureResponse(observation({ classification: "flaky_test" }), () => 0.5);

    expect(decision).toMatchObject({ retry: "allowed", followUp: "stabilization_task" });
  });

  it("keeps the stabilization task after the flaky retry is spent", () => {
    const decision = decideFailureResponse(
      observation({ classification: "flaky_test", attempt: 2 }),
      () => 0.5,
    );

    expect(decision).toMatchObject({ retry: "denied", followUp: "stabilization_task" });
  });

  it("never retries a deployment health failure, because rollback already ran once", () => {
    const decision = decideFailureResponse(
      observation({ stage: "deployment", classification: "deployment_health" }),
      () => 0.5,
    );

    expect(decision).toMatchObject({
      retry: "denied",
      followUp: "repair_task",
      notifyOwner: true,
    });
  });
});

describe("repeated infrastructure failure", () => {
  it("opens one deduplicated incident and pauses the release path", () => {
    const decision = decideFailureResponse(
      observation({ classification: "transient_infrastructure", attempt: 2, recentSameSignatureFailures: 2 }),
      () => 0.5,
    );

    expect(decision).toMatchObject({
      retry: "denied",
      incident: "opened",
      releasePath: "paused",
      notifyOwner: true,
    });
  });

  it("deduplicates against an incident already open for the same signature", () => {
    const decision = decideFailureResponse(
      observation({
        classification: "transient_infrastructure",
        attempt: 2,
        recentSameSignatureFailures: 5,
        openIncidentSignature: `sha256:${"e".repeat(64)}`,
      }),
      () => 0.5,
    );

    expect(decision.incident).toBe("deduplicated");
    expect(decision.releasePath).toBe("paused");
    expect(decision.notifyOwner).toBe(false);
  });

  it("does not treat an unrelated open incident as a duplicate", () => {
    const decision = decideFailureResponse(
      observation({
        classification: "transient_infrastructure",
        attempt: 2,
        recentSameSignatureFailures: 2,
        openIncidentSignature: `sha256:${"f".repeat(64)}`,
      }),
      () => 0.5,
    );

    expect(decision.incident).toBe("opened");
  });
});

describe("owner notification boundary", () => {
  it("notifies the owner only for the conditions the plan lists", () => {
    const notifying = [
      { stage: "deployment", classification: "deployment_health" },
      { stage: "release", classification: "secret_exposure" },
      { stage: "deployment", classification: "blocked_destructive_migration" },
      { stage: "release", classification: "pooled_budget_critical" },
      { stage: "release", classification: "platform_integrity" },
    ] as const;

    for (const patch of notifying) {
      expect(decideFailureResponse(observation(patch), () => 0.5).notifyOwner).toBe(true);
    }
    for (const classification of ["deterministic", "flaky_test"] as const) {
      expect(decideFailureResponse(observation({ classification }), () => 0.5).notifyOwner).toBe(false);
    }
  });

  it("fails a secret exposure closed, revoking and pausing the release path", () => {
    const decision = decideFailureResponse(
      observation({ stage: "release", classification: "secret_exposure" }),
      () => 0.5,
    );

    expect(decision).toMatchObject({
      retry: "denied",
      followUp: "security_incident",
      incident: "opened",
      releasePath: "paused",
      rotateCredential: true,
    });
  });
});

describe("failure observation validation", () => {
  it("rejects an attempt count that is not a bounded positive integer", () => {
    for (const attempt of [0, -1, 1.5, 100]) {
      expect(() => decideFailureResponse(observation({ attempt }), () => 0.5))
        .toThrow(FailurePolicyError);
    }
  });

  it("rejects a signature that is not a sha256 digest", () => {
    expect(() => decideFailureResponse(observation({ signature: "not-a-digest" }), () => 0.5))
      .toThrow(FailurePolicyError);
  });

  it("rejects a jitter source outside the unit interval", () => {
    expect(() => decideFailureResponse(
      observation({ classification: "transient_infrastructure" }),
      () => 1.5,
    )).toThrow(FailurePolicyError);
  });
});
