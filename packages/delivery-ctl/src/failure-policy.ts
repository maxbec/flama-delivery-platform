/**
 * Plan section 20 states the failure and recovery rules as policy, not as
 * suggestions: a deterministic failure is never retried, a recognized transient
 * failure gets exactly one jittered retry, a flake is retried once and always
 * recorded, repeated infrastructure failure opens one deduplicated incident and
 * pauses the release path, and the owner is notified only for the listed
 * conditions. This module is the single deterministic decision point for those
 * rules so no caller re-invents them.
 */

export type FailureStage = "preflight" | "final" | "release" | "deployment";

export type FailureClassification =
  | "deterministic"
  | "flaky_test"
  | "transient_infrastructure"
  | "deployment_health"
  | "secret_exposure"
  | "blocked_destructive_migration"
  | "pooled_budget_critical"
  | "platform_integrity";

export interface FailureObservation {
  readonly schemaVersion: 1;
  readonly stage: FailureStage;
  readonly classification: FailureClassification;
  /** Digest of the normalized failure fingerprint. Never a message or a path. */
  readonly signature: string;
  readonly attempt: number;
  readonly recentSameSignatureFailures: number;
  readonly openIncidentSignature?: string;
}

export type RetryDisposition = "allowed" | "denied";
export type FollowUp = "none" | "repair_task" | "stabilization_task" | "security_incident";
export type IncidentDisposition = "none" | "opened" | "deduplicated";

export interface FailureDecision {
  readonly schemaVersion: 1;
  readonly retry: RetryDisposition;
  readonly retryDelaySeconds: number | null;
  readonly followUp: FollowUp;
  readonly incident: IncidentDisposition;
  readonly releasePath: "open" | "paused";
  readonly notifyOwner: boolean;
  readonly rotateCredential: boolean;
}

export type FailurePolicyErrorCode = "failure_observation_invalid" | "failure_jitter_invalid";

export class FailurePolicyError extends Error {
  constructor(readonly code: FailurePolicyErrorCode) {
    super("Failure observation rejected");
    this.name = "FailurePolicyError";
  }
}

const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const maximumAttempts = 20;
const retryFloorSeconds = 5;
const retryCeilingSeconds = 35;

/** Repeated infrastructure failure, not a single recognized blip. */
const repeatedInfrastructureThreshold = 2;

const ownerNotifiedClassifications: ReadonlySet<FailureClassification> = new Set([
  "deployment_health",
  "secret_exposure",
  "blocked_destructive_migration",
  "pooled_budget_critical",
  "platform_integrity",
]);

/** Exactly one retry is ever permitted, and only for a recognized transient cause. */
const retryableOnce: ReadonlySet<FailureClassification> = new Set([
  "flaky_test",
  "transient_infrastructure",
]);

function assertObservation(observation: FailureObservation): void {
  if (
    observation.schemaVersion !== 1 ||
    !digestPattern.test(observation.signature) ||
    !Number.isInteger(observation.attempt) ||
    observation.attempt < 1 ||
    observation.attempt > maximumAttempts ||
    !Number.isInteger(observation.recentSameSignatureFailures) ||
    observation.recentSameSignatureFailures < 0 ||
    observation.recentSameSignatureFailures > 1_000 ||
    (observation.openIncidentSignature !== undefined &&
      !digestPattern.test(observation.openIncidentSignature))
  ) throw new FailurePolicyError("failure_observation_invalid");
}

function jitteredDelaySeconds(jitter: number): number {
  if (!Number.isFinite(jitter) || jitter < 0 || jitter >= 1) {
    throw new FailurePolicyError("failure_jitter_invalid");
  }
  const span = retryCeilingSeconds - retryFloorSeconds;
  return retryFloorSeconds + Math.floor(jitter * (span + 1));
}

export function decideFailureResponse(
  observation: FailureObservation,
  jitterSource: () => number,
): FailureDecision {
  assertObservation(observation);

  const retryAvailable = retryableOnce.has(observation.classification) && observation.attempt === 1;
  const retryDelaySeconds = retryAvailable ? jitteredDelaySeconds(jitterSource()) : null;

  const repeatedInfrastructure =
    observation.classification === "transient_infrastructure" &&
    observation.recentSameSignatureFailures >= repeatedInfrastructureThreshold;

  const incidentWorthy =
    repeatedInfrastructure ||
    observation.classification === "secret_exposure" ||
    observation.classification === "platform_integrity";

  const duplicate = observation.openIncidentSignature === observation.signature;
  const incident: IncidentDisposition = !incidentWorthy
    ? "none"
    : duplicate
      ? "deduplicated"
      : "opened";

  let followUp: FollowUp = "none";
  if (observation.classification === "flaky_test") followUp = "stabilization_task";
  else if (observation.classification === "secret_exposure") followUp = "security_incident";
  else if (!retryAvailable) followUp = "repair_task";

  return {
    schemaVersion: 1,
    retry: retryAvailable ? "allowed" : "denied",
    retryDelaySeconds,
    followUp,
    incident,
    releasePath: incident === "none" ? "open" : "paused",
    // A duplicate incident must not page the owner again for the same signature.
    notifyOwner: ownerNotifiedClassifications.has(observation.classification)
      ? incident !== "deduplicated"
      : incident === "opened",
    rotateCredential: observation.classification === "secret_exposure",
  };
}
