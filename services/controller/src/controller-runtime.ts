import { createHash } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import {
  auditReconciliation,
  createReconciliationRuntime,
  planReconciliation,
  type ReconciliationEvidence,
  type ReconciliationInput,
  type ReconciliationResult,
} from "../../../packages/delivery-ctl/src/reconcile.js";
import {
  resolvePaperclipRoutineContract,
  type PaperclipRoutineContract,
  type PaperclipRoutineDetail,
  type ResolvedPaperclipRoutineContract,
} from "../../../packages/delivery-ctl/src/paperclip-routines.js";

const controllerNames = [
  "maxbec-delivery-controller",
  "navigaite-delivery-controller",
  "edilio-delivery-controller",
] as const;
type ControllerName = typeof controllerNames[number];
type CompanyName = "Private" | "// Navigaite" | "Edilio";
type AuditStatus = Exclude<ReconciliationResult["status"], "planned">;

const expectedCompanies: Readonly<Record<ControllerName, CompanyName>> = {
  "maxbec-delivery-controller": "Private",
  "navigaite-delivery-controller": "// Navigaite",
  "edilio-delivery-controller": "Edilio",
};
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const maximumResponseBytes = 2 * 1024 * 1024;

type Environment = Readonly<Record<string, string | undefined>>;
type FetchImplementation = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface RuntimeIdentity {
  readonly apiBase: string;
  readonly token: string;
  readonly agentId: string;
  readonly companyId: string;
  readonly runId: string;
}

interface ControllerIdentity {
  readonly id: string;
  readonly companyId: string;
  readonly name: ControllerName;
  readonly role: "devops";
  readonly adapterType: "process";
  readonly budgetMonthlyCents: 0;
}

interface ControllerContract {
  readonly schemaVersion: 1;
  readonly name: ControllerName;
  readonly mode: "company-delivery";
  readonly scope: {
    readonly companies: readonly [CompanyName];
    readonly githubOwners: readonly string[];
  };
  readonly runtime: {
    readonly deterministic: true;
    readonly maxImplementationConcurrency: 2;
    readonly credentialSource: "infisical-oidc";
  };
}

interface RoutineAssignment {
  readonly id: string;
  readonly companyId: string;
  readonly projectId: string;
  readonly title: string;
  readonly description: string;
  readonly status: string;
  readonly priority: string;
  readonly assigneeAgentId: string;
  readonly executionRunId: string;
  readonly originKind: string;
  readonly originId: string;
  readonly originRunId: string;
}

interface RoutineRun {
  readonly id: string;
  readonly companyId: string;
  readonly routineId: string;
  readonly triggerId: string;
  readonly source: string;
  readonly status: string;
  readonly linkedIssueId: string;
  readonly completedAt: string | null;
}

export type ControllerRuntimeResult =
  | {
    readonly schemaVersion: 1;
    readonly status: "idle";
    readonly contractDigest: string;
  }
  | {
    readonly schemaVersion: 1;
    readonly status: AuditStatus;
    readonly contractDigest: string;
    readonly evidenceDigest: string;
  };

export type ControllerRuntimeErrorCode =
  | "controller_api_rejected"
  | "controller_assignment_unsupported"
  | "controller_contract_invalid"
  | "controller_evidence_unavailable"
  | "controller_identity_invalid"
  | "controller_identity_unavailable"
  | "controller_reconciliation_failed"
  | "controller_response_invalid"
  | "controller_routine_drift";

export class ControllerRuntimeError extends Error {
  constructor(readonly code: ControllerRuntimeErrorCode) {
    super("controller runtime rejected");
    this.name = "ControllerRuntimeError";
  }
}

export type ManagedReconciliationExecutor = (
  input: ReconciliationInput,
  environment: Environment,
  runId: string,
) => Promise<ReconciliationResult>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: string): boolean {
  return uuidPattern.test(value);
}

function isControllerName(value: unknown): value is ControllerName {
  return typeof value === "string" && controllerNames.includes(value as ControllerName);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex")}`;
}

function formattedDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(`${JSON.stringify(value, null, 2)}\n`).digest("hex")}`;
}

function runtimeIdentity(environment: Environment): RuntimeIdentity {
  const apiBase = environment["PAPERCLIP_API_URL"];
  const token = environment["PAPERCLIP_API_KEY"];
  const agentId = environment["PAPERCLIP_AGENT_ID"];
  const companyId = environment["PAPERCLIP_COMPANY_ID"];
  const runId = environment["PAPERCLIP_RUN_ID"];
  if (
    apiBase === undefined || token === undefined || agentId === undefined || companyId === undefined || runId === undefined ||
    token.length < 20 || token.length > 4_096 || /[\r\n]/u.test(token) ||
    !isUuid(agentId) || !isUuid(companyId) || !isUuid(runId)
  ) throw new ControllerRuntimeError("controller_identity_unavailable");
  let parsed: URL;
  try {
    parsed = new URL(apiBase);
  } catch {
    throw new ControllerRuntimeError("controller_identity_unavailable");
  }
  const loopbackHttp = parsed.protocol === "http:" &&
    ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname);
  if ((parsed.protocol !== "https:" && !loopbackHttp) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ControllerRuntimeError("controller_identity_unavailable");
  }
  return {
    apiBase: parsed.toString().replace(/\/+$/u, ""),
    token,
    agentId,
    companyId,
    runId,
  };
}

async function requestJson(
  identity: RuntimeIdentity,
  method: "GET" | "PATCH",
  endpoint: string,
  fetchImplementation: FetchImplementation,
  body?: unknown,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImplementation(`${identity.apiBase}${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${identity.token}`,
        Accept: "application/json",
        "X-Paperclip-Run-Id": identity.runId,
        "User-Agent": "flama-delivery-controller/0.1.0",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ControllerRuntimeError("controller_api_rejected");
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new ControllerRuntimeError("controller_api_rejected");
  }
  const contentType = response.headers.get("content-type");
  const contentLength = response.headers.get("content-length");
  if (
    contentType === null || !/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/iu.test(contentType) ||
    (contentLength !== null && (!/^[0-9]+$/u.test(contentLength) || Number(contentLength) > maximumResponseBytes))
  ) {
    await response.body?.cancel();
    throw new ControllerRuntimeError("controller_response_invalid");
  }
  let source: string;
  try {
    source = await response.text();
  } catch {
    throw new ControllerRuntimeError("controller_response_invalid");
  }
  if (Buffer.byteLength(source, "utf8") > maximumResponseBytes) {
    throw new ControllerRuntimeError("controller_response_invalid");
  }
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new ControllerRuntimeError("controller_response_invalid");
  }
}

function parseIdentity(value: unknown, runtime: RuntimeIdentity): ControllerIdentity {
  if (
    !isRecord(value) || value["id"] !== runtime.agentId || value["companyId"] !== runtime.companyId ||
    !isControllerName(value["name"]) || value["role"] !== "devops" || value["adapterType"] !== "process" ||
    value["budgetMonthlyCents"] !== 0
  ) throw new ControllerRuntimeError("controller_identity_invalid");
  return value as unknown as ControllerIdentity;
}

function validateControllerContract(value: unknown, identity: ControllerIdentity): ControllerContract {
  if (!isRecord(value) || !isRecord(value["scope"]) || !isRecord(value["runtime"])) {
    throw new ControllerRuntimeError("controller_contract_invalid");
  }
  const companies = value["scope"]["companies"];
  const owners = value["scope"]["githubOwners"];
  if (
    value["schemaVersion"] !== 1 || value["name"] !== identity.name || value["mode"] !== "company-delivery" ||
    !Array.isArray(companies) || companies.length !== 1 || companies[0] !== expectedCompanies[identity.name] ||
    !Array.isArray(owners) || owners.length !== 1 || typeof owners[0] !== "string" ||
    value["runtime"]["deterministic"] !== true || value["runtime"]["maxImplementationConcurrency"] !== 2 ||
    value["runtime"]["credentialSource"] !== "infisical-oidc"
  ) throw new ControllerRuntimeError("controller_contract_invalid");
  return value as unknown as ControllerContract;
}

async function readJsonContract(path: string, code: ControllerRuntimeErrorCode): Promise<unknown> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
    return JSON.parse(source) as unknown;
  } catch {
    throw new ControllerRuntimeError(code);
  }
}

function parseAssignment(value: unknown): RoutineAssignment {
  if (
    !isRecord(value) || typeof value["id"] !== "string" || typeof value["companyId"] !== "string" ||
    typeof value["projectId"] !== "string" || typeof value["title"] !== "string" ||
    typeof value["description"] !== "string" || typeof value["status"] !== "string" ||
    typeof value["priority"] !== "string" || typeof value["assigneeAgentId"] !== "string" ||
    typeof value["executionRunId"] !== "string" || typeof value["originKind"] !== "string" ||
    typeof value["originId"] !== "string" || typeof value["originRunId"] !== "string"
  ) throw new ControllerRuntimeError("controller_response_invalid");
  return value as unknown as RoutineAssignment;
}

function parseRoutine(value: unknown): PaperclipRoutineDetail {
  if (
    !isRecord(value) || typeof value["id"] !== "string" || typeof value["companyId"] !== "string" ||
    (value["projectId"] !== null && typeof value["projectId"] !== "string") ||
    (value["folderId"] !== undefined && value["folderId"] !== null && typeof value["folderId"] !== "string") ||
    (value["goalId"] !== null && typeof value["goalId"] !== "string") ||
    (value["parentIssueId"] !== null && typeof value["parentIssueId"] !== "string") ||
    typeof value["title"] !== "string" || (value["description"] !== null && typeof value["description"] !== "string") ||
    (value["assigneeAgentId"] !== null && typeof value["assigneeAgentId"] !== "string") ||
    typeof value["priority"] !== "string" || typeof value["status"] !== "string" ||
    typeof value["concurrencyPolicy"] !== "string" || typeof value["catchUpPolicy"] !== "string" ||
    !Array.isArray(value["variables"]) || !Array.isArray(value["triggers"])
  ) throw new ControllerRuntimeError("controller_response_invalid");
  for (const trigger of value["triggers"]) {
    if (
      !isRecord(trigger) || typeof trigger["id"] !== "string" || typeof trigger["kind"] !== "string" ||
      (trigger["label"] !== null && typeof trigger["label"] !== "string") || typeof trigger["enabled"] !== "boolean" ||
      (trigger["cronExpression"] !== null && typeof trigger["cronExpression"] !== "string") ||
      (trigger["timezone"] !== null && typeof trigger["timezone"] !== "string")
    ) throw new ControllerRuntimeError("controller_response_invalid");
  }
  return value as unknown as PaperclipRoutineDetail;
}

function parseRoutineRuns(value: unknown): readonly RoutineRun[] {
  if (!Array.isArray(value) || value.length > 50) throw new ControllerRuntimeError("controller_response_invalid");
  return value.map((run) => {
    if (
      !isRecord(run) || typeof run["id"] !== "string" || typeof run["companyId"] !== "string" ||
      typeof run["routineId"] !== "string" || typeof run["triggerId"] !== "string" ||
      typeof run["source"] !== "string" || typeof run["status"] !== "string" ||
      typeof run["linkedIssueId"] !== "string" ||
      (run["completedAt"] !== null && typeof run["completedAt"] !== "string")
    ) throw new ControllerRuntimeError("controller_response_invalid");
    return run as unknown as RoutineRun;
  });
}

function reconciliationInput(
  runtime: RuntimeIdentity,
  identity: ControllerIdentity,
  contract: PaperclipRoutineContract,
): ReconciliationInput {
  return {
    schemaVersion: 1,
    company: { id: runtime.companyId, name: expectedCompanies[identity.name] },
    controller: identity.name,
    controls: contract.execution.controls,
    mutationAllowed: false,
  };
}

function validateAuditResult(input: ReconciliationInput, result: ReconciliationResult): asserts result is ReconciliationResult & {
  readonly status: AuditStatus;
  readonly evidenceDigest: string;
} {
  const planned = planReconciliation(input);
  if (
    !["compliant", "attention", "insufficient_data"].includes(result.status) ||
    result.controller !== input.controller || result.mode !== "read_only" ||
    result.contractDigest !== planned.contractDigest ||
    typeof result.evidenceDigest !== "string" || !digestPattern.test(result.evidenceDigest)
  ) throw new ControllerRuntimeError("controller_reconciliation_failed");
}

async function safeEvidencePath(environment: Environment, runId: string): Promise<string> {
  const directory = environment["FLAMA_RECONCILIATION_EVIDENCE_DIR"];
  if (
    !isUuid(runId) ||
    directory === undefined || directory.length === 0 || directory.length > 4_096 || /[\r\n\u0000]/u.test(directory) ||
    !isAbsolute(directory) || normalize(directory) !== directory
  ) throw new ControllerRuntimeError("controller_evidence_unavailable");
  try {
    const [metadata, canonical] = await Promise.all([lstat(directory), realpath(directory)]);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || canonical !== directory) {
      throw new Error("unsafe directory");
    }
  } catch {
    throw new ControllerRuntimeError("controller_evidence_unavailable");
  }
  return join(directory, `reconciliation-${runId}.json`);
}

export async function writeManagedReconciliationEvidence(
  environment: Environment,
  runId: string,
  evidence: ReconciliationEvidence,
): Promise<void> {
  const outputPath = await safeEvidencePath(environment, runId);
  await writePrivateEvidence(outputPath, evidence);
}

async function writePrivateEvidence(outputPath: string, evidence: ReconciliationEvidence): Promise<void> {
  try {
    await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch {
    throw new ControllerRuntimeError("controller_evidence_unavailable");
  }
}

export const executeManagedReconciliation: ManagedReconciliationExecutor = async (input, environment, runId) => {
  const outputPath = await safeEvidencePath(environment, runId);
  const runtime = createReconciliationRuntime(environment);
  let audit: { readonly result: ReconciliationResult; readonly evidence: ReconciliationEvidence };
  try {
    audit = await auditReconciliation(input, runtime);
  } catch {
    throw new ControllerRuntimeError("controller_reconciliation_failed");
  } finally {
    try {
      await runtime.close();
    } catch {
      // Preserve the stable reconciliation failure boundary after a broken pool.
    }
  }
  validateAuditResult(input, audit.result);
  if (
    audit.evidence.status !== audit.result.status || audit.evidence.controller !== input.controller ||
    audit.evidence.mode !== "read_only" || formattedDigest(audit.evidence) !== audit.result.evidenceDigest
  ) throw new ControllerRuntimeError("controller_reconciliation_failed");
  await writePrivateEvidence(outputPath, audit.evidence);
  return audit.result;
};

export async function runControllerRuntime(
  environment: Environment,
  repositoryRoot: string,
  fetchImplementation: FetchImplementation = fetch,
  executeReconciliation: ManagedReconciliationExecutor = executeManagedReconciliation,
): Promise<ControllerRuntimeResult> {
  const runtime = runtimeIdentity(environment);
  const identity = parseIdentity(
    await requestJson(runtime, "GET", "/api/agents/me", fetchImplementation),
    runtime,
  );
  const controllerContract = validateControllerContract(
    await readJsonContract(
      join(repositoryRoot, "lifecycles", "controllers", `${identity.name}.json`),
      "controller_contract_invalid",
    ),
    identity,
  );
  const contractDigest = digest(controllerContract);
  const query = new URLSearchParams({
    assigneeAgentId: runtime.agentId,
    status: "todo,in_progress,in_review,blocked",
    limit: "100",
  });
  const rawAssignments = await requestJson(
    runtime,
    "GET",
    `/api/companies/${encodeURIComponent(runtime.companyId)}/issues?${query.toString()}`,
    fetchImplementation,
  );
  if (!Array.isArray(rawAssignments)) throw new ControllerRuntimeError("controller_response_invalid");
  if (rawAssignments.length === 0) return { schemaVersion: 1, status: "idle", contractDigest };
  if (rawAssignments.length !== 1) throw new ControllerRuntimeError("controller_assignment_unsupported");
  const assignment = parseAssignment(rawAssignments[0]);
  if (
    !isUuid(assignment.id) || assignment.companyId !== runtime.companyId || !isUuid(assignment.projectId) ||
    assignment.assigneeAgentId !== runtime.agentId || assignment.status !== "in_progress" ||
    assignment.priority !== "low" || assignment.executionRunId !== runtime.runId ||
    assignment.originKind !== "routine_execution" || !isUuid(assignment.originId) || !isUuid(assignment.originRunId)
  ) throw new ControllerRuntimeError("controller_assignment_unsupported");

  const rawRoutineContract = await readJsonContract(
    join(repositoryRoot, "routines", "nightly-reconciliation.json"),
    "controller_contract_invalid",
  );
  let routineContract: PaperclipRoutineContract;
  let resolved: ResolvedPaperclipRoutineContract;
  try {
    routineContract = rawRoutineContract as PaperclipRoutineContract;
    resolved = resolvePaperclipRoutineContract(expectedCompanies[identity.name], routineContract);
  } catch {
    throw new ControllerRuntimeError("controller_contract_invalid");
  }
  const routine = parseRoutine(await requestJson(
    runtime,
    "GET",
    `/api/routines/${encodeURIComponent(assignment.originId)}`,
    fetchImplementation,
  ));
  const trigger = routine.triggers[0];
  if (
    routine.id !== assignment.originId || routine.companyId !== runtime.companyId ||
    routine.projectId !== assignment.projectId || routine.folderId != null || routine.goalId !== null ||
    routine.parentIssueId !== null || routine.title !== resolved.title || routine.description !== resolved.description ||
    routine.assigneeAgentId !== runtime.agentId || routine.priority !== resolved.priority || routine.status !== "active" ||
    routine.concurrencyPolicy !== resolved.concurrencyPolicy || routine.catchUpPolicy !== resolved.catchUpPolicy ||
    routine.variables.length !== 0 || routine.triggers.length !== 1 || trigger === undefined || !isUuid(trigger.id) ||
    trigger.kind !== resolved.trigger.kind || trigger.label !== resolved.trigger.label ||
    trigger.enabled !== resolved.trigger.enabled || trigger.cronExpression !== resolved.trigger.cronExpression ||
    trigger.timezone !== resolved.trigger.timezone || assignment.title !== resolved.title ||
    assignment.description !== resolved.description
  ) throw new ControllerRuntimeError("controller_routine_drift");

  const runs = parseRoutineRuns(await requestJson(
    runtime,
    "GET",
    `/api/routines/${encodeURIComponent(routine.id)}/runs?limit=50`,
    fetchImplementation,
  ));
  const matchingRuns = runs.filter((run) => run.id === assignment.originRunId);
  const routineRun = matchingRuns[0];
  if (
    matchingRuns.length !== 1 || routineRun === undefined || routineRun.companyId !== runtime.companyId ||
    routineRun.routineId !== routine.id || routineRun.triggerId !== trigger.id || routineRun.source !== "schedule" ||
    routineRun.status !== "issue_created" || routineRun.linkedIssueId !== assignment.id || routineRun.completedAt !== null
  ) throw new ControllerRuntimeError("controller_routine_drift");

  const auditInput = reconciliationInput(runtime, identity, routineContract);
  let reconciliation: ReconciliationResult;
  try {
    reconciliation = await executeReconciliation(
      auditInput,
      environment,
      runtime.runId,
    );
    validateAuditResult(auditInput, reconciliation);
  } catch (error) {
    if (error instanceof ControllerRuntimeError) throw error;
    throw new ControllerRuntimeError("controller_reconciliation_failed");
  }
  const evidenceDigest = reconciliation.evidenceDigest;
  const nextStatus = reconciliation.status === "compliant" ? "done" : "in_review";
  const comment = reconciliation.status === "compliant"
    ? `Read-only reconciliation completed. Evidence digest: ${evidenceDigest}.`
    : `Read-only reconciliation requires review (${reconciliation.status}). Evidence digest: ${evidenceDigest}.`;
  const updated = await requestJson(
    runtime,
    "PATCH",
    `/api/issues/${encodeURIComponent(assignment.id)}`,
    fetchImplementation,
    { status: nextStatus, comment },
  );
  if (
    !isRecord(updated) || updated["id"] !== assignment.id || updated["companyId"] !== runtime.companyId ||
    updated["status"] !== nextStatus
  ) throw new ControllerRuntimeError("controller_response_invalid");
  return {
    schemaVersion: 1,
    status: reconciliation.status,
    contractDigest,
    evidenceDigest,
  };
}
