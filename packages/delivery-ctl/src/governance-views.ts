/**
 * Plan section 9 lists `compliance` and `usage` commands. Their measurement logic
 * belongs to the read-only Governance Controller, which already produces one
 * validated result. These are projections of that result, so no rule or threshold
 * is computed twice, and neither view reaches a network or an identity.
 */

type GovernanceStatus = "compliant" | "attention" | "insufficient_data";
type ScopeKey = "maxbec" | "navigaite" | "edilio";
type PaperclipDimension = "company" | "controller" | "lifecycles";

interface Percentiles {
  readonly p50: number | null;
  readonly p95: number | null;
}

interface ProfileSummary {
  readonly status: GovernanceStatus;
  readonly samples: number;
  readonly wallSeconds: Percentiles;
  readonly queueSeconds: Percentiles;
  readonly runnerSeconds: Percentiles;
  readonly retryRuns: number;
}

interface DeliverySummary {
  readonly status: GovernanceStatus;
  readonly fast: ProfileSummary;
  readonly major: ProfileSummary;
  readonly cacheHitRate: { readonly value: number | null; readonly coverage: "reported" | "not_emitted" };
}

export interface GovernanceResultInput {
  readonly schemaVersion: 1;
  readonly window: { readonly from: string; readonly to: string };
  readonly status: GovernanceStatus;
  readonly scopes: readonly {
    readonly key: ScopeKey;
    readonly status: GovernanceStatus;
    readonly paperclip: Readonly<Record<PaperclipDimension, "compliant" | "drift">>;
    readonly delivery: DeliverySummary;
  }[];
  readonly pooled: DeliverySummary;
}

export interface CiBudgetPolicy {
  readonly version: 1;
  readonly pool: string;
  readonly targets: {
    readonly fast: {
      readonly p50WallMinutes: number;
      readonly p95WallMinutes: number;
      readonly runnerMinutesPerMainPr: number;
    };
    readonly major: {
      readonly p50WallMinutes: number;
      readonly p95WallMinutes: number;
      readonly runnerMinutesPerPromotion: number;
    };
  };
}

export interface ComplianceView {
  readonly schemaVersion: 1;
  readonly status: GovernanceStatus;
  readonly window: GovernanceResultInput["window"];
  readonly scopes: readonly {
    readonly key: ScopeKey;
    readonly status: GovernanceStatus;
    readonly drift: readonly PaperclipDimension[];
  }[];
}

export interface UsageProfileView {
  readonly samples: number;
  readonly wallSecondsP50: number | null;
  readonly wallSecondsP95: number | null;
  readonly queueSecondsP95: number | null;
  readonly runnerSecondsP95: number | null;
  readonly retryRuns: number;
  readonly targetWallSecondsP50: number;
  readonly targetWallSecondsP95: number;
  readonly targetRunnerSeconds: number;
  /** Null when the profile produced no samples: unmeasured is not compliant. */
  readonly withinTarget: boolean | null;
}

export interface UsageView {
  readonly schemaVersion: 1;
  readonly pool: string;
  readonly window: GovernanceResultInput["window"];
  readonly status: GovernanceStatus;
  readonly cacheHitRate: DeliverySummary["cacheHitRate"];
  readonly profiles: { readonly fast: UsageProfileView; readonly major: UsageProfileView };
}

export type GovernanceViewErrorCode = "governance_result_invalid" | "ci_budget_policy_invalid";

export class GovernanceViewError extends Error {
  constructor(readonly code: GovernanceViewErrorCode) {
    super("Governance view input rejected");
    this.name = "GovernanceViewError";
  }
}

const dimensions: readonly PaperclipDimension[] = ["company", "controller", "lifecycles"];

function assertResult(result: GovernanceResultInput): void {
  if (
    result.schemaVersion !== 1 ||
    !Array.isArray(result.scopes) ||
    result.scopes.length === 0 ||
    typeof result.window?.from !== "string" ||
    typeof result.window.to !== "string"
  ) throw new GovernanceViewError("governance_result_invalid");
}

export function complianceView(result: GovernanceResultInput): ComplianceView {
  assertResult(result);
  /**
   * Compliance status is derived from the Paperclip dimensions alone. The scope
   * status in the governance result also folds in delivery metrics, and a slow
   * pipeline is a budget matter, not a compliance breach.
   */
  const scopes = result.scopes.map((scope) => {
    const drift = dimensions.filter((dimension) => scope.paperclip[dimension] === "drift");
    return {
      key: scope.key,
      status: (drift.length === 0 ? "compliant" : "attention") as GovernanceStatus,
      drift,
    };
  });
  return {
    schemaVersion: 1,
    status: scopes.some((scope) => scope.status === "attention") ? "attention" : "compliant",
    window: result.window,
    scopes,
  };
}

function profileView(
  summary: ProfileSummary,
  targets: { readonly p50Wall: number; readonly p95Wall: number; readonly runner: number },
): UsageProfileView {
  const withinTarget = summary.samples === 0
    ? null
    : (summary.wallSeconds.p50 ?? 0) < targets.p50Wall &&
      (summary.wallSeconds.p95 ?? 0) < targets.p95Wall &&
      (summary.runnerSeconds.p95 ?? 0) < targets.runner;
  return {
    samples: summary.samples,
    wallSecondsP50: summary.wallSeconds.p50,
    wallSecondsP95: summary.wallSeconds.p95,
    queueSecondsP95: summary.queueSeconds.p95,
    runnerSecondsP95: summary.runnerSeconds.p95,
    retryRuns: summary.retryRuns,
    targetWallSecondsP50: targets.p50Wall,
    targetWallSecondsP95: targets.p95Wall,
    targetRunnerSeconds: targets.runner,
    withinTarget,
  };
}

export function usageView(result: GovernanceResultInput, policy: CiBudgetPolicy): UsageView {
  assertResult(result);
  if (policy.version !== 1 || typeof policy.pool !== "string" || policy.pool.length === 0) {
    throw new GovernanceViewError("ci_budget_policy_invalid");
  }
  const minutes = (value: number): number => {
    if (!Number.isFinite(value) || value <= 0) throw new GovernanceViewError("ci_budget_policy_invalid");
    return value * 60;
  };
  return {
    schemaVersion: 1,
    pool: policy.pool,
    window: result.window,
    status: result.pooled.status,
    cacheHitRate: result.pooled.cacheHitRate,
    profiles: {
      fast: profileView(result.pooled.fast, {
        p50Wall: minutes(policy.targets.fast.p50WallMinutes),
        p95Wall: minutes(policy.targets.fast.p95WallMinutes),
        runner: minutes(policy.targets.fast.runnerMinutesPerMainPr),
      }),
      major: profileView(result.pooled.major, {
        p50Wall: minutes(policy.targets.major.p50WallMinutes),
        p95Wall: minutes(policy.targets.major.p95WallMinutes),
        runner: minutes(policy.targets.major.runnerMinutesPerPromotion),
      }),
    },
  };
}
