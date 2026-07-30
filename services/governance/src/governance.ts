import {
  verifyPaperclipGovernanceAttestationDigest,
  type PaperclipGovernanceAttestation,
} from "../../../packages/contracts/src/paperclip-governance-attestation.js";

type ScopeKey = "maxbec" | "navigaite" | "edilio";
type CompanyName = "Private" | "// Navigaite" | "Edilio";
type ControllerName =
  | "maxbec-delivery-controller"
  | "navigaite-delivery-controller"
  | "edilio-delivery-controller";
type Profile = "fast" | "major";
type GovernanceStatus = "compliant" | "attention" | "insufficient_data";

const scopeKeys = ["maxbec", "navigaite", "edilio"] as const;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const repositoryPattern = /^[A-Za-z0-9._-]{1,100}$/u;
const scopeContract: Readonly<Record<ScopeKey, {
  readonly company: CompanyName;
  readonly githubOwner: ScopeKey;
  readonly controller: ControllerName;
}>> = {
  maxbec: {
    company: "Private",
    githubOwner: "maxbec",
    controller: "maxbec-delivery-controller",
  },
  navigaite: {
    company: "// Navigaite",
    githubOwner: "navigaite",
    controller: "navigaite-delivery-controller",
  },
  edilio: {
    company: "Edilio",
    githubOwner: "edilio",
    controller: "edilio-delivery-controller",
  },
};

export interface GovernanceInput {
  readonly schemaVersion: 1;
  readonly window: { readonly from: string; readonly to: string };
  readonly scopes: readonly {
    readonly key: ScopeKey;
    readonly company: CompanyName;
    readonly githubOwner: ScopeKey;
    readonly controller: ControllerName;
    readonly paperclipAttestation: PaperclipGovernanceAttestation;
    readonly repositories: readonly {
      readonly name: string;
      readonly profile: Profile;
      readonly finalWorkflow: string;
    }[];
  }[];
}

export interface GitHubWorkflowRun {
  readonly id: number;
  readonly name: string;
  readonly event: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly runAttempt: number;
  readonly createdAt: string;
  readonly runStartedAt: string;
  readonly updatedAt: string;
  readonly baseRefs: readonly string[];
}

export interface GitHubWorkflowJob {
  readonly status: string;
  readonly conclusion: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export interface GitHubGovernanceReader {
  listRuns(owner: ScopeKey, repository: string, from: string, to: string): Promise<readonly GitHubWorkflowRun[]>;
  listJobs(owner: ScopeKey, repository: string, runId: number, attempt: number): Promise<readonly GitHubWorkflowJob[]>;
}

export interface GovernanceReaders {
  github(key: ScopeKey): GitHubGovernanceReader;
}

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

export interface GovernanceResult {
  readonly schemaVersion: 1;
  readonly window: { readonly from: string; readonly to: string };
  readonly status: GovernanceStatus;
  readonly scopes: readonly {
    readonly key: ScopeKey;
    readonly status: GovernanceStatus;
    readonly paperclip: {
      readonly company: "compliant" | "drift";
      readonly controller: "compliant" | "drift";
      readonly lifecycles: "compliant" | "drift";
    };
    readonly delivery: DeliverySummary;
  }[];
  readonly pooled: DeliverySummary;
}

export type GovernanceErrorCode =
  | "governance_identity_unavailable"
  | "governance_input_invalid"
  | "governance_metadata_invalid"
  | "governance_read_failed";

export class GovernanceError extends Error {
  constructor(readonly code: GovernanceErrorCode) {
    super("governance collection rejected");
    this.name = "GovernanceError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

function validDateTime(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function asScopeKey(value: unknown): ScopeKey | undefined {
  return typeof value === "string" && scopeKeys.includes(value as ScopeKey) ? value as ScopeKey : undefined;
}

export function parseGovernanceInput(value: unknown): GovernanceInput {
  if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "window", "scopes"]) || value["schemaVersion"] !== 1) {
    throw new GovernanceError("governance_input_invalid");
  }
  const window = value["window"];
  const scopes = value["scopes"];
  if (!isRecord(window) || !exactKeys(window, ["from", "to"]) ||
    !validDateTime(window["from"]) || !validDateTime(window["to"]) || !Array.isArray(scopes) || scopes.length !== 3) {
    throw new GovernanceError("governance_input_invalid");
  }
  const from = Date.parse(window["from"]);
  const to = Date.parse(window["to"]);
  if (to <= from || to - from > 31 * 24 * 60 * 60 * 1_000) {
    throw new GovernanceError("governance_input_invalid");
  }

  const seenScopes = new Set<ScopeKey>();
  const normalizedScopes: GovernanceInput["scopes"][number][] = [];
  for (const scope of scopes) {
    if (!isRecord(scope) || !exactKeys(scope, [
      "key", "company", "githubOwner", "controller", "paperclipAttestation", "repositories",
    ])) {
      throw new GovernanceError("governance_input_invalid");
    }
    const key = asScopeKey(scope["key"]);
    const expected = key === undefined ? undefined : scopeContract[key];
    const repositories = scope["repositories"];
    const attestation = scope["paperclipAttestation"];
    if (key === undefined || expected === undefined || seenScopes.has(key) ||
      scope["company"] !== expected.company || scope["githubOwner"] !== expected.githubOwner ||
      scope["controller"] !== expected.controller || !isRecord(attestation) || !exactKeys(attestation, [
        "source", "company", "controller", "runId", "observedAt", "evidenceDigest", "checks",
      ]) || attestation["source"] !== "paperclip-company-controller" ||
      attestation["company"] !== expected.company || attestation["controller"] !== expected.controller ||
      typeof attestation["runId"] !== "string" || !uuidPattern.test(attestation["runId"]) ||
      !validDateTime(attestation["observedAt"]) || Date.parse(attestation["observedAt"]) < from ||
      Date.parse(attestation["observedAt"]) > to || typeof attestation["evidenceDigest"] !== "string" ||
      !digestPattern.test(attestation["evidenceDigest"]) || !isRecord(attestation["checks"]) ||
      !exactKeys(attestation["checks"], ["company", "controller", "lifecycles"]) ||
      !["compliant", "drift"].includes(String(attestation["checks"]["company"])) ||
      !["compliant", "drift"].includes(String(attestation["checks"]["controller"])) ||
      !["compliant", "drift"].includes(String(attestation["checks"]["lifecycles"])) ||
      !Array.isArray(repositories) || repositories.length > 100) {
      throw new GovernanceError("governance_input_invalid");
    }
    const normalizedAttestation: PaperclipGovernanceAttestation = {
      source: "paperclip-company-controller",
      company: expected.company,
      controller: expected.controller,
      runId: attestation["runId"],
      observedAt: attestation["observedAt"],
      evidenceDigest: attestation["evidenceDigest"],
      checks: {
        company: attestation["checks"]["company"] as "compliant" | "drift",
        controller: attestation["checks"]["controller"] as "compliant" | "drift",
        lifecycles: attestation["checks"]["lifecycles"] as "compliant" | "drift",
      },
    };
    if (!verifyPaperclipGovernanceAttestationDigest(normalizedAttestation)) {
      throw new GovernanceError("governance_input_invalid");
    }
    const seenRepositories = new Set<string>();
    const normalizedRepositories: GovernanceInput["scopes"][number]["repositories"][number][] = [];
    for (const repository of repositories) {
      if (!isRecord(repository) || !exactKeys(repository, ["name", "profile", "finalWorkflow"]) ||
        typeof repository["name"] !== "string" || !repositoryPattern.test(repository["name"]) ||
        seenRepositories.has(repository["name"].toLowerCase()) ||
        (repository["profile"] !== "fast" && repository["profile"] !== "major") ||
        typeof repository["finalWorkflow"] !== "string" || repository["finalWorkflow"].length < 1 ||
        repository["finalWorkflow"].length > 200 || /[\u0000-\u001f\u007f]/u.test(repository["finalWorkflow"])) {
        throw new GovernanceError("governance_input_invalid");
      }
      seenRepositories.add(repository["name"].toLowerCase());
      normalizedRepositories.push({
        name: repository["name"],
        profile: repository["profile"],
        finalWorkflow: repository["finalWorkflow"],
      });
    }
    seenScopes.add(key);
    normalizedScopes.push({
      key,
      company: expected.company,
      githubOwner: expected.githubOwner,
      controller: expected.controller,
      paperclipAttestation: normalizedAttestation,
      repositories: normalizedRepositories,
    });
  }
  if (seenScopes.size !== 3) throw new GovernanceError("governance_input_invalid");
  return {
    schemaVersion: 1,
    window: { from: window["from"], to: window["to"] },
    scopes: scopeKeys.map((key) => {
      const scope = normalizedScopes.find((candidate) => candidate.key === key);
      if (scope === undefined) throw new GovernanceError("governance_input_invalid");
      return scope;
    }),
  };
}

interface MetricSample {
  readonly profile: Profile;
  readonly wallSeconds: number;
  readonly queueSeconds: number;
  readonly runnerSeconds: number;
  readonly retried: boolean;
}

function secondsBetween(start: string, end: string): number {
  const startTime = Date.parse(start);
  const endTime = Date.parse(end);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime < startTime || endTime - startTime > 7 * 24 * 60 * 60 * 1_000) {
    throw new GovernanceError("governance_metadata_invalid");
  }
  return Math.ceil((endTime - startTime) / 1_000);
}

async function collectSamples(
  scope: GovernanceInput["scopes"][number],
  reader: GitHubGovernanceReader,
  window: GovernanceInput["window"],
): Promise<readonly MetricSample[]> {
  const samples: MetricSample[] = [];
  for (const repository of scope.repositories) {
    const runs = await reader.listRuns(scope.githubOwner, repository.name, window.from, window.to);
    const seenRuns = new Set<number>();
    for (const run of runs) {
      if (seenRuns.has(run.id)) throw new GovernanceError("governance_metadata_invalid");
      seenRuns.add(run.id);
      if (run.name !== repository.finalWorkflow || run.event !== "pull_request" || run.status !== "completed" ||
        !run.baseRefs.includes("main")) continue;
      if (run.runAttempt < 1 || !Number.isSafeInteger(run.runAttempt)) {
        throw new GovernanceError("governance_metadata_invalid");
      }
      const jobs = await reader.listJobs(scope.githubOwner, repository.name, run.id, run.runAttempt);
      if (jobs.length === 0) throw new GovernanceError("governance_metadata_invalid");
      let runnerSeconds = 0;
      for (const job of jobs) {
        if (job.startedAt === null && job.completedAt === null) continue;
        if (job.startedAt === null || job.completedAt === null) {
          throw new GovernanceError("governance_metadata_invalid");
        }
        runnerSeconds += secondsBetween(job.startedAt, job.completedAt);
      }
      samples.push({
        profile: repository.profile,
        wallSeconds: secondsBetween(run.runStartedAt, run.updatedAt),
        queueSeconds: secondsBetween(run.createdAt, run.runStartedAt),
        runnerSeconds,
        retried: run.runAttempt > 1,
      });
    }
  }
  return samples;
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
}

export const governanceTargets = {
  fast: { p50Wall: 180, p95Wall: 360, runner: 480 },
  major: { p50Wall: 360, p95Wall: 720, runner: 1_200 },
} as const;

function profileSummary(samples: readonly MetricSample[], profile: Profile, configured: boolean): ProfileSummary {
  const matching = samples.filter((sample) => sample.profile === profile);
  const wallSeconds = { p50: percentile(matching.map((sample) => sample.wallSeconds), 0.5), p95: percentile(matching.map((sample) => sample.wallSeconds), 0.95) };
  const queueSeconds = { p50: percentile(matching.map((sample) => sample.queueSeconds), 0.5), p95: percentile(matching.map((sample) => sample.queueSeconds), 0.95) };
  const runnerSeconds = { p50: percentile(matching.map((sample) => sample.runnerSeconds), 0.5), p95: percentile(matching.map((sample) => sample.runnerSeconds), 0.95) };
  let status: GovernanceStatus = "compliant";
  if (configured && matching.length === 0) status = "insufficient_data";
  else if (matching.length > 0 && (
    (wallSeconds.p50 ?? 0) >= governanceTargets[profile].p50Wall ||
    (wallSeconds.p95 ?? 0) >= governanceTargets[profile].p95Wall ||
    (runnerSeconds.p95 ?? 0) >= governanceTargets[profile].runner
  )) status = "attention";
  return {
    status,
    samples: matching.length,
    wallSeconds,
    queueSeconds,
    runnerSeconds,
    retryRuns: matching.filter((sample) => sample.retried).length,
  };
}

function deliverySummary(samples: readonly MetricSample[], configuredProfiles: ReadonlySet<Profile>): DeliverySummary {
  const fast = profileSummary(samples, "fast", configuredProfiles.has("fast"));
  const major = profileSummary(samples, "major", configuredProfiles.has("major"));
  const statuses = [...configuredProfiles].map((profile) => profile === "fast" ? fast.status : major.status);
  const status: GovernanceStatus = statuses.includes("attention")
    ? "attention"
    : statuses.includes("insufficient_data") || statuses.length === 0
      ? "insufficient_data"
      : "compliant";
  return { status, fast, major, cacheHitRate: { value: null, coverage: "not_emitted" } };
}

function combinedStatus(values: readonly GovernanceStatus[]): GovernanceStatus {
  if (values.includes("attention")) return "attention";
  if (values.includes("insufficient_data")) return "insufficient_data";
  return "compliant";
}

export async function collectGovernance(
  rawInput: unknown,
  readers: GovernanceReaders,
): Promise<GovernanceResult> {
  const input = parseGovernanceInput(rawInput);
  const scopeResults: GovernanceResult["scopes"][number][] = [];
  const allSamples: MetricSample[] = [];
  const allProfiles = new Set<Profile>();
  for (const scope of input.scopes) {
    let samples: readonly MetricSample[];
    try {
      samples = await collectSamples(scope, readers.github(scope.key), input.window);
    } catch (error) {
      if (error instanceof GovernanceError) throw error;
      throw new GovernanceError("governance_read_failed");
    }
    const paperclip = {
      company: scope.paperclipAttestation.checks.company,
      controller: scope.paperclipAttestation.checks.controller,
      lifecycles: scope.paperclipAttestation.checks.lifecycles,
    };
    const configuredProfiles = new Set(scope.repositories.map((repository) => repository.profile));
    const delivery = deliverySummary(samples, configuredProfiles);
    const paperclipStatus: GovernanceStatus = paperclip.company === "compliant" &&
      paperclip.controller === "compliant" && paperclip.lifecycles === "compliant"
      ? "compliant"
      : "attention";
    scopeResults.push({
      key: scope.key,
      status: combinedStatus([paperclipStatus, delivery.status]),
      paperclip,
      delivery,
    });
    allSamples.push(...samples);
    configuredProfiles.forEach((profile) => allProfiles.add(profile));
  }
  const pooled = deliverySummary(allSamples, allProfiles);
  return {
    schemaVersion: 1,
    window: input.window,
    status: combinedStatus([...scopeResults.map((scope) => scope.status), pooled.status]),
    scopes: scopeResults,
    pooled,
  };
}
