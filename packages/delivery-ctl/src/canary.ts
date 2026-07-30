import { createHash } from "node:crypto";

type Owner = "maxbec" | "navigaite" | "edilio-app";
type Profile = "fast" | "major";
type ProofName = keyof CanaryProofs;
type ProofStatus = "passed" | "failed" | "not_applicable";
type ResultProofStatus = "planned" | "passed" | "failed";
type FindingLocation = "candidate" | "coverage" | "evidence" | "input";

const proofNames = [
  "preflight",
  "autoMerge",
  "release",
  "deploymentApproval",
  "secretIsolation",
  "infisicalOidc",
  "infisicalSync",
  "rollback",
  "eventReplay",
  "pooledCost",
] as const satisfies readonly ProofName[];

export interface CanaryProofs {
  readonly preflight: ProofStatus;
  readonly autoMerge: ProofStatus;
  readonly release: ProofStatus;
  readonly deploymentApproval: ProofStatus;
  readonly secretIsolation: ProofStatus;
  readonly infisicalOidc: ProofStatus;
  readonly infisicalSync: ProofStatus;
  readonly rollback: ProofStatus;
  readonly eventReplay: ProofStatus;
  readonly pooledCost: ProofStatus;
}

export interface CanaryCandidate {
  readonly key: string;
  readonly repository: {
    readonly nameWithOwner: string;
    readonly owner: Owner;
    readonly visibility: "private" | "public";
    readonly isFork: false;
    readonly isArchived: false;
  };
  readonly profile: Profile;
  readonly source: { readonly branch: "main" | "dev"; readonly sha: string };
  readonly coverage: {
    readonly legacyStack: boolean;
    readonly libraryRelease: boolean;
    readonly dockerDeployment: boolean;
    readonly managedPlatformDeployment: boolean;
  };
  readonly policyDigests: {
    readonly github: string;
    readonly secrets: string;
    readonly paperclipBinding: string;
  };
  readonly evidence: null | {
    readonly sourceSha: string;
    readonly observedAt: string;
    readonly evidenceDigest: string;
    readonly proofs: CanaryProofs;
  };
}

export interface CanaryInput {
  readonly schemaVersion: 1;
  readonly platformRef: string;
  readonly inventoryDigest: string;
  readonly candidates: readonly CanaryCandidate[];
  readonly mutationAllowed: false;
}

export interface CanaryCoverage {
  readonly fast: boolean;
  readonly major: boolean;
  readonly private: boolean;
  readonly public: boolean;
  readonly maxbec: boolean;
  readonly navigaite: boolean;
  readonly edilio: boolean;
  readonly legacyStack: boolean;
  readonly libraryRelease: boolean;
  readonly dockerDeployment: boolean;
  readonly managedPlatformDeployment: boolean;
}

export interface CanaryFinding {
  readonly code: string;
  readonly location: FindingLocation;
}

export interface CanaryResult {
  readonly schemaVersion: 1;
  readonly status: "planned" | "passed" | "failed";
  readonly coverage: CanaryCoverage;
  readonly proofs: Readonly<Record<ProofName, ResultProofStatus>>;
  readonly findingCount: number;
  readonly findings: readonly CanaryFinding[];
  readonly planDigest: string;
  readonly evidenceDigest?: string;
}

const shaPattern = /^[0-9a-f]{40}$/u;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const candidateKeyPattern = /^canary-[a-z0-9][a-z0-9-]{0,62}$/u;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(
      ([key, nested]) => [key, stableValue(nested)],
    ));
  }
  return value;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex")}`;
}

function coverage(input: CanaryInput): CanaryCoverage {
  return {
    fast: input.candidates.some(({ profile }) => profile === "fast"),
    major: input.candidates.some(({ profile }) => profile === "major"),
    private: input.candidates.some(({ repository }) => repository.visibility === "private"),
    public: input.candidates.some(({ repository }) => repository.visibility === "public"),
    maxbec: input.candidates.some(({ repository }) => repository.owner === "maxbec"),
    navigaite: input.candidates.some(({ repository }) => repository.owner === "navigaite"),
    edilio: input.candidates.some(({ repository }) => repository.owner === "edilio-app"),
    legacyStack: input.candidates.some(({ coverage: value }) => value.legacyStack),
    libraryRelease: input.candidates.some(({ coverage: value }) => value.libraryRelease),
    dockerDeployment: input.candidates.some(({ coverage: value }) => value.dockerDeployment),
    managedPlatformDeployment: input.candidates.some(({ coverage: value }) => value.managedPlatformDeployment),
  };
}

function plannedProofs(): Readonly<Record<ProofName, "planned">> {
  return Object.fromEntries(proofNames.map((name) => [name, "planned"])) as unknown as Readonly<
    Record<ProofName, "planned">
  >;
}

function planValue(input: CanaryInput): unknown {
  return {
    schemaVersion: input.schemaVersion,
    platformRef: input.platformRef,
    inventoryDigest: input.inventoryDigest,
    candidates: input.candidates.map(({ evidence: _evidence, ...candidate }) => candidate),
    mutationAllowed: input.mutationAllowed,
  };
}

function validatePlan(input: CanaryInput): { readonly coverage: CanaryCoverage; readonly findings: CanaryFinding[] } {
  const findings: CanaryFinding[] = [];
  const add = (code: string, location: FindingLocation): void => {
    findings.push({ code, location });
  };
  if (
    input.schemaVersion !== 1 || input.mutationAllowed !== false || !shaPattern.test(input.platformRef) ||
    !digestPattern.test(input.inventoryDigest) || input.candidates.length < 3 || input.candidates.length > 12
  ) add("canary_input_invalid", "input");
  const keys = new Set<string>();
  const repositories = new Set<string>();
  for (const candidate of input.candidates) {
    if (!candidateKeyPattern.test(candidate.key) || keys.has(candidate.key)) add("candidate_key_invalid", "candidate");
    keys.add(candidate.key);
    if (repositories.has(candidate.repository.nameWithOwner)) add("candidate_repository_duplicate", "candidate");
    repositories.add(candidate.repository.nameWithOwner);
    const [owner, name, extra] = candidate.repository.nameWithOwner.split("/");
    if (
      extra !== undefined || name === undefined || name.length === 0 || owner !== candidate.repository.owner ||
      candidate.repository.isFork || candidate.repository.isArchived || !shaPattern.test(candidate.source.sha) ||
      candidate.source.branch !== (candidate.profile === "major" ? "dev" : "main") ||
      !Object.values(candidate.policyDigests).every((value) => digestPattern.test(value)) ||
      (candidate.coverage.dockerDeployment && candidate.coverage.managedPlatformDeployment)
    ) add("candidate_scope_invalid", "candidate");
  }
  const observedCoverage = coverage(input);
  if (Object.values(observedCoverage).some((covered) => !covered)) add("canary_coverage_incomplete", "coverage");
  findings.sort((left, right) => left.code === right.code
    ? left.location.localeCompare(right.location)
    : left.code.localeCompare(right.code));
  return { coverage: observedCoverage, findings };
}

export function planCanaries(input: CanaryInput): CanaryResult {
  const validated = validatePlan(input);
  if (input.candidates.some(({ evidence }) => evidence !== null)) {
    validated.findings.push({ code: "canary_plan_contains_evidence", location: "evidence" });
    validated.findings.sort((left, right) => left.code.localeCompare(right.code));
  }
  return {
    schemaVersion: 1,
    status: validated.findings.length === 0 ? "planned" : "failed",
    coverage: validated.coverage,
    proofs: plannedProofs(),
    findingCount: validated.findings.length,
    findings: validated.findings,
    planDigest: digest(planValue(input)),
  };
}

function proofSummary(candidates: readonly CanaryCandidate[]): Readonly<Record<ProofName, "passed" | "failed">> {
  return Object.fromEntries(proofNames.map((name) => [
    name,
    candidates.some(({ evidence }) => evidence?.proofs[name] === "failed") ||
      !candidates.some(({ evidence }) => evidence?.proofs[name] === "passed")
      ? "failed"
      : "passed",
  ])) as unknown as Readonly<Record<ProofName, "passed" | "failed">>;
}

export function auditCanaries(input: CanaryInput): CanaryResult {
  const validated = validatePlan(input);
  const evidenceValues: unknown[] = [];
  for (const candidate of input.candidates) {
    const evidence = candidate.evidence;
    if (evidence === null) {
      validated.findings.push({ code: "canary_evidence_missing", location: "evidence" });
      continue;
    }
    evidenceValues.push({ key: candidate.key, evidence });
    if (
      evidence.sourceSha !== candidate.source.sha || !digestPattern.test(evidence.evidenceDigest) ||
      !Number.isFinite(Date.parse(evidence.observedAt))
    ) validated.findings.push({ code: "canary_evidence_invalid", location: "evidence" });
    for (const name of ["preflight", "autoMerge", "secretIsolation", "eventReplay", "pooledCost"] as const) {
      if (evidence.proofs[name] !== "passed") {
        validated.findings.push({ code: "required_canary_proof_failed", location: "evidence" });
      }
    }
    if (candidate.coverage.libraryRelease && evidence.proofs.release !== "passed") {
      validated.findings.push({ code: "library_release_proof_failed", location: "evidence" });
    }
    if (!candidate.coverage.libraryRelease && evidence.proofs.release === "failed") {
      validated.findings.push({ code: "release_proof_failed", location: "evidence" });
    }
    const deployable = candidate.coverage.dockerDeployment || candidate.coverage.managedPlatformDeployment;
    if (deployable && (evidence.proofs.deploymentApproval !== "passed" || evidence.proofs.rollback !== "passed")) {
      validated.findings.push({ code: "deployment_proof_failed", location: "evidence" });
    }
    if (!deployable && (evidence.proofs.deploymentApproval === "failed" || evidence.proofs.rollback === "failed")) {
      validated.findings.push({ code: "deployment_proof_failed", location: "evidence" });
    }
  }
  const proofs = proofSummary(input.candidates);
  if (proofs.infisicalOidc !== "passed") {
    validated.findings.push({ code: "infisical_oidc_proof_missing", location: "evidence" });
  }
  if (proofs.infisicalSync !== "passed") {
    validated.findings.push({ code: "infisical_sync_proof_missing", location: "evidence" });
  }
  validated.findings.sort((left, right) => left.code === right.code
    ? left.location.localeCompare(right.location)
    : left.code.localeCompare(right.code));
  return {
    schemaVersion: 1,
    status: validated.findings.length === 0 ? "passed" : "failed",
    coverage: validated.coverage,
    proofs,
    findingCount: validated.findings.length,
    findings: validated.findings,
    planDigest: digest(planValue(input)),
    evidenceDigest: digest(evidenceValues),
  };
}
