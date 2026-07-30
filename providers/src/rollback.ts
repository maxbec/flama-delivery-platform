import type {
  ArtifactReference,
  DeploymentAdapter,
  DeploymentCheck,
  DeploymentClock,
  ProviderEvidence,
  ProviderName,
  VerificationRunner,
} from "./orchestrator.js";

export interface RollbackRevision {
  readonly version: string;
  readonly artifact: ArtifactReference;
}

export interface RollbackInput {
  readonly schemaVersion: 1;
  readonly provider: { readonly name: ProviderName };
  readonly current: RollbackRevision;
  readonly target: RollbackRevision;
  readonly verification: { readonly expectedVersion: string; readonly soakSeconds: number };
  readonly migration: { readonly rollbackCompatible: boolean };
  readonly authorization: { readonly drill: boolean; readonly incidentRef: string | null };
}

export type RollbackStatus = "planned" | "restored" | "failed";

export interface RollbackResult {
  readonly schemaVersion: 1;
  readonly status: RollbackStatus;
  readonly provider: ProviderName;
  readonly restoredDigest: string;
  readonly supersededDigest: string;
  readonly drill: boolean;
  readonly attempts: 0 | 1;
  readonly checks: readonly DeploymentCheck[];
  readonly reasonCode?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly providerEvidence?: ProviderEvidence;
}

export interface RollbackExecutionOptions {
  readonly input: RollbackInput;
  readonly adapter: DeploymentAdapter;
  readonly verification: VerificationRunner;
  readonly clock: DeploymentClock;
  readonly intervalSeconds: number;
}

export type RollbackErrorCode =
  | "rollback_migration_incompatible"
  | "rollback_provider_mismatch"
  | "rollback_target_invalid"
  | "rollback_unauthorized"
  | "rollback_verification_invalid";

export class RollbackError extends Error {
  constructor(readonly code: RollbackErrorCode) {
    super("Rollback rejected");
    this.name = "RollbackError";
  }
}

const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const minimumSoakSeconds = 600;

function assertRollbackAllowed(input: RollbackInput): void {
  if (
    !digestPattern.test(input.target.artifact.digest) ||
    input.target.artifact.digest === input.current.artifact.digest ||
    input.target.artifact.uri.length === 0 ||
    /:latest$/u.test(input.target.artifact.uri)
  ) throw new RollbackError("rollback_target_invalid");
  if (
    input.verification.expectedVersion !== input.target.version ||
    !Number.isInteger(input.verification.soakSeconds) ||
    input.verification.soakSeconds < minimumSoakSeconds
  ) throw new RollbackError("rollback_verification_invalid");
  if (!input.migration.rollbackCompatible) throw new RollbackError("rollback_migration_incompatible");
  if (!input.authorization.drill && (input.authorization.incidentRef ?? "").length === 0) {
    throw new RollbackError("rollback_unauthorized");
  }
}

function base(input: RollbackInput): Pick<
  RollbackResult,
  "schemaVersion" | "provider" | "restoredDigest" | "supersededDigest" | "drill"
> {
  return {
    schemaVersion: 1,
    provider: input.provider.name,
    restoredDigest: input.target.artifact.digest,
    supersededDigest: input.current.artifact.digest,
    drill: input.authorization.drill,
  };
}

export function planRollback(input: RollbackInput): RollbackResult {
  assertRollbackAllowed(input);
  return { ...base(input), status: "planned", attempts: 0, checks: [] };
}

async function verifyRestore(
  options: RollbackExecutionOptions,
  phase: "immediate" | "soak",
): Promise<{ readonly check: DeploymentCheck; readonly reasonCode?: string }> {
  const health = await options.adapter.health();
  const version = (await options.adapter.deployedVersion()) === options.input.verification.expectedVersion;
  const smoke = await options.verification.smoke(options.input.verification.expectedVersion);
  const check: DeploymentCheck = {
    observedAt: options.clock.now().toISOString(),
    phase,
    health,
    version,
    smoke,
  };
  if (!health) return { check, reasonCode: "health_failed" };
  if (!version) return { check, reasonCode: "version_mismatch" };
  if (!smoke) return { check, reasonCode: "smoke_failed" };
  return { check };
}

export async function executeRollback(options: RollbackExecutionOptions): Promise<RollbackResult> {
  const { input } = options;
  assertRollbackAllowed(input);
  if (options.adapter.name !== input.provider.name) {
    throw new RollbackError("rollback_provider_mismatch");
  }
  if (
    !Number.isInteger(options.intervalSeconds) ||
    options.intervalSeconds <= 0 ||
    options.intervalSeconds > input.verification.soakSeconds
  ) throw new RollbackError("rollback_verification_invalid");

  const startedAt = options.clock.now().toISOString();
  const checks: DeploymentCheck[] = [];
  const failed = (reasonCode: string): RollbackResult => ({
    ...base(input),
    status: "failed",
    attempts: 1,
    checks: [...checks],
    reasonCode,
    startedAt,
    finishedAt: options.clock.now().toISOString(),
  });

  try {
    await options.adapter.rollback(input.target.artifact);
  } catch {
    return failed("rollback_failed");
  }

  try {
    const immediate = await verifyRestore(options, "immediate");
    checks.push(immediate.check);
    if (immediate.reasonCode !== undefined) return failed(immediate.reasonCode);

    let elapsedSeconds = 0;
    while (elapsedSeconds < input.verification.soakSeconds) {
      const waitSeconds = Math.min(options.intervalSeconds, input.verification.soakSeconds - elapsedSeconds);
      await options.clock.wait(waitSeconds);
      elapsedSeconds += waitSeconds;
      const soak = await verifyRestore(options, "soak");
      checks.push(soak.check);
      if (soak.reasonCode !== undefined) return failed(soak.reasonCode);
    }

    const observed = await options.adapter.evidence();
    if (observed.deploymentId.length === 0 || Number.isNaN(Date.parse(observed.observedAt))) {
      return failed("invalid_provider_evidence");
    }
    return {
      ...base(input),
      status: "restored",
      attempts: 1,
      checks: [...checks],
      startedAt,
      finishedAt: options.clock.now().toISOString(),
      providerEvidence: { deploymentId: observed.deploymentId, observedAt: observed.observedAt },
    };
  } catch {
    return failed("rollback_verification_error");
  }
}
