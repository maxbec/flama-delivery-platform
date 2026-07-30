import { createHash } from "node:crypto";

type CompanyName = "Private" | "// Navigaite" | "Edilio";
type ControllerName =
  | "maxbec-delivery-controller"
  | "navigaite-delivery-controller"
  | "edilio-delivery-controller";

const companyControllers: Readonly<Record<CompanyName, ControllerName>> = {
  Private: "maxbec-delivery-controller",
  "// Navigaite": "navigaite-delivery-controller",
  Edilio: "edilio-delivery-controller",
};
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface PaperclipRoutineContract {
  readonly schemaVersion: 1;
  readonly key: "flama-nightly-reconciliation-v1";
  readonly title: "Flama Nightly Delivery Reconciliation";
  readonly description: string;
  readonly priority: "low";
  readonly initialStatus: "paused";
  readonly concurrencyPolicy: "coalesce_if_active";
  readonly catchUpPolicy: "skip_missed";
  readonly execution: {
    readonly command: "reconcile";
    readonly mode: "read_only";
    readonly evidenceDirectoryEnvironment: "FLAMA_RECONCILIATION_EVIDENCE_DIR";
    readonly controls: {
      readonly queueLagSeconds: 900;
      readonly staleClaimSeconds: 300;
      readonly authorizationExpiryWarningSeconds: 300;
      readonly lookbackSeconds: 172800;
      readonly maximumAuthorizationRecords: 500;
    };
  };
  readonly trigger: {
    readonly kind: "schedule";
    readonly label: "flama-nightly-reconciliation-v1";
    readonly enabled: true;
    readonly timezone: "Europe/Berlin";
    readonly cronByCompany: Readonly<Record<CompanyName, string>>;
  };
}

export interface PaperclipRoutinesInput {
  readonly schemaVersion: 1;
  readonly company: { readonly id: string; readonly name: CompanyName };
  readonly controller: ControllerName;
  readonly controllerAgentId: string;
  readonly projectId: string;
  readonly mutationAllowed: true;
}

interface RoutineSpec {
  readonly key: "flama-nightly-reconciliation-v1";
  readonly title: string;
  readonly description: string;
  readonly projectId: string;
  readonly assigneeAgentId: string;
  readonly priority: "low";
  readonly status: "paused";
  readonly concurrencyPolicy: "coalesce_if_active";
  readonly catchUpPolicy: "skip_missed";
  readonly variables: readonly [];
  readonly trigger: {
    readonly kind: "schedule";
    readonly label: string;
    readonly enabled: true;
    readonly cronExpression: string;
    readonly timezone: "Europe/Berlin";
  };
  readonly contractDigest: string;
}

export interface ResolvedPaperclipRoutineContract {
  readonly key: "flama-nightly-reconciliation-v1";
  readonly title: "Flama Nightly Delivery Reconciliation";
  readonly description: string;
  readonly priority: "low";
  readonly concurrencyPolicy: "coalesce_if_active";
  readonly catchUpPolicy: "skip_missed";
  readonly execution: PaperclipRoutineContract["execution"];
  readonly trigger: RoutineSpec["trigger"];
  readonly contractDigest: string;
}

export interface PaperclipRoutineDetail {
  readonly id: string;
  readonly companyId: string;
  readonly projectId: string | null;
  readonly folderId?: string | null;
  readonly goalId: string | null;
  readonly parentIssueId: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly assigneeAgentId: string | null;
  readonly priority: string;
  readonly status: string;
  readonly concurrencyPolicy: string;
  readonly catchUpPolicy: string;
  readonly variables: readonly unknown[];
  readonly triggers: readonly {
    readonly id: string;
    readonly kind: string;
    readonly label: string | null;
    readonly enabled: boolean;
    readonly cronExpression: string | null;
    readonly timezone: string | null;
    readonly signingMode?: string | null;
    readonly replayWindowSec?: number | null;
  }[];
}

export interface PaperclipRoutinesClient {
  getCompany(companyId: string): Promise<{ readonly id: string; readonly name: string; readonly status?: string }>;
  getAgent(agentId: string): Promise<{
    readonly id: string;
    readonly companyId: string;
    readonly name: string;
    readonly role: string;
    readonly adapterType: string;
    readonly budgetMonthlyCents: number;
    readonly status: string;
  }>;
  getProject(projectId: string): Promise<{
    readonly id: string;
    readonly companyId: string;
    readonly status: string;
    readonly archivedAt?: string | null;
  }>;
  listRoutines(companyId: string): Promise<readonly { readonly id: string; readonly title: string }[]>;
  createRoutine(companyId: string, input: Omit<RoutineSpec, "key" | "trigger" | "contractDigest">): Promise<{ readonly id: string }>;
  getRoutine(routineId: string): Promise<PaperclipRoutineDetail>;
  createScheduleTrigger(routineId: string, input: RoutineSpec["trigger"]): Promise<void>;
}

export interface PaperclipRoutinesResult {
  readonly schemaVersion: 1;
  readonly status: "planned" | "applied";
  readonly controller: ControllerName;
  readonly routineKey: "flama-nightly-reconciliation-v1";
  readonly disposition: "planned" | "created" | "reused";
  readonly initialStatus: "paused";
  readonly trigger: {
    readonly kind: "schedule";
    readonly enabled: true;
    readonly cronExpression: string;
    readonly timezone: "Europe/Berlin";
  };
  readonly contractDigest: string;
}

export type PaperclipRoutinesErrorCode =
  | "paperclip_agent_approval_required"
  | "paperclip_agent_mismatch"
  | "paperclip_api_rejected"
  | "paperclip_company_mismatch"
  | "paperclip_contract_invalid"
  | "paperclip_identity_unavailable"
  | "paperclip_project_mismatch"
  | "paperclip_response_invalid"
  | "paperclip_routine_drift"
  | "paperclip_scope_invalid";

export class PaperclipRoutinesError extends Error {
  constructor(readonly code: PaperclipRoutinesErrorCode) {
    super("Paperclip routine provisioning rejected");
    this.name = "PaperclipRoutinesError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(
      ([key, nested]) => [key, stableValue(nested)],
    ));
  }
  return value;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex")}`;
}

function validateInput(input: PaperclipRoutinesInput): void {
  if (input.schemaVersion !== 1 || input.mutationAllowed !== true ||
    companyControllers[input.company.name] !== input.controller || !uuidPattern.test(input.company.id) ||
    !uuidPattern.test(input.controllerAgentId) || !uuidPattern.test(input.projectId)) {
    throw new PaperclipRoutinesError("paperclip_scope_invalid");
  }
}

function validateContract(contract: PaperclipRoutineContract): void {
  const expectedCron = {
    Private: "17 1 * * *",
    "// Navigaite": "31 1 * * *",
    Edilio: "47 1 * * *",
  } as const;
  if (!isRecord(contract.execution) || !isRecord(contract.execution.controls) || !isRecord(contract.trigger) ||
    contract.schemaVersion !== 1 || contract.key !== "flama-nightly-reconciliation-v1" ||
    contract.title !== "Flama Nightly Delivery Reconciliation" || contract.description.length < 100 ||
    contract.description.length > 2_000 || /[\u0000\r]/u.test(contract.description) ||
    contract.priority !== "low" || contract.initialStatus !== "paused" ||
    contract.concurrencyPolicy !== "coalesce_if_active" || contract.catchUpPolicy !== "skip_missed" ||
    contract.execution.command !== "reconcile" || contract.execution.mode !== "read_only" ||
    contract.execution.evidenceDirectoryEnvironment !== "FLAMA_RECONCILIATION_EVIDENCE_DIR" ||
    contract.execution.controls.queueLagSeconds !== 900 ||
    contract.execution.controls.staleClaimSeconds !== 300 ||
    contract.execution.controls.authorizationExpiryWarningSeconds !== 300 ||
    contract.execution.controls.lookbackSeconds !== 172_800 ||
    contract.execution.controls.maximumAuthorizationRecords !== 500 ||
    contract.trigger.kind !== "schedule" || contract.trigger.label !== contract.key ||
    contract.trigger.enabled !== true || contract.trigger.timezone !== "Europe/Berlin" ||
    JSON.stringify(stableValue(contract.trigger.cronByCompany)) !== JSON.stringify(stableValue(expectedCron))) {
    throw new PaperclipRoutinesError("paperclip_contract_invalid");
  }
}

export function resolvePaperclipRoutineContract(
  company: CompanyName,
  contract: PaperclipRoutineContract,
): ResolvedPaperclipRoutineContract {
  validateContract(contract);
  const contractDigest = digest(contract);
  return {
    key: contract.key,
    title: contract.title,
    description: `Managed by flama-delivery-platform; key=${contract.key}; contract=${contractDigest}\n\n${contract.description}`,
    priority: contract.priority,
    concurrencyPolicy: contract.concurrencyPolicy,
    catchUpPolicy: contract.catchUpPolicy,
    execution: contract.execution,
    trigger: {
      kind: contract.trigger.kind,
      label: contract.trigger.label,
      enabled: contract.trigger.enabled,
      cronExpression: contract.trigger.cronByCompany[company],
      timezone: contract.trigger.timezone,
    },
    contractDigest,
  };
}

function routineSpec(input: PaperclipRoutinesInput, contract: PaperclipRoutineContract): RoutineSpec {
  validateInput(input);
  const resolved = resolvePaperclipRoutineContract(input.company.name, contract);
  return {
    key: resolved.key,
    title: resolved.title,
    description: resolved.description,
    projectId: input.projectId,
    assigneeAgentId: input.controllerAgentId,
    priority: contract.priority,
    status: contract.initialStatus,
    concurrencyPolicy: resolved.concurrencyPolicy,
    catchUpPolicy: resolved.catchUpPolicy,
    variables: [],
    trigger: {
      ...resolved.trigger,
    },
    contractDigest: resolved.contractDigest,
  };
}

function result(
  input: PaperclipRoutinesInput,
  spec: RoutineSpec,
  status: "planned" | "applied",
  disposition: "planned" | "created" | "reused",
): PaperclipRoutinesResult {
  return {
    schemaVersion: 1,
    status,
    controller: input.controller,
    routineKey: spec.key,
    disposition,
    initialStatus: "paused",
    trigger: {
      kind: "schedule",
      enabled: true,
      cronExpression: spec.trigger.cronExpression,
      timezone: "Europe/Berlin",
    },
    contractDigest: spec.contractDigest,
  };
}

function coreMatches(routine: PaperclipRoutineDetail, input: PaperclipRoutinesInput, spec: RoutineSpec): boolean {
  return routine.companyId === input.company.id && routine.projectId === spec.projectId &&
    routine.folderId == null && routine.goalId === null && routine.parentIssueId === null &&
    routine.title === spec.title && routine.description === spec.description &&
    routine.assigneeAgentId === spec.assigneeAgentId && routine.priority === spec.priority &&
    routine.status === spec.status && routine.concurrencyPolicy === spec.concurrencyPolicy &&
    routine.catchUpPolicy === spec.catchUpPolicy && routine.variables.length === 0;
}

function triggerMatches(routine: PaperclipRoutineDetail, spec: RoutineSpec): boolean {
  const trigger = routine.triggers[0];
  return routine.triggers.length === 1 && trigger !== undefined && trigger.kind === spec.trigger.kind &&
    trigger.label === spec.trigger.label && trigger.enabled === spec.trigger.enabled &&
    trigger.cronExpression === spec.trigger.cronExpression && trigger.timezone === spec.trigger.timezone;
}

export function planPaperclipRoutines(
  input: PaperclipRoutinesInput,
  contract: PaperclipRoutineContract,
): PaperclipRoutinesResult {
  return result(input, routineSpec(input, contract), "planned", "planned");
}

export async function applyPaperclipRoutines(
  input: PaperclipRoutinesInput,
  contract: PaperclipRoutineContract,
  client: PaperclipRoutinesClient,
): Promise<PaperclipRoutinesResult> {
  const spec = routineSpec(input, contract);
  const [company, agent, project, routines] = await Promise.all([
    client.getCompany(input.company.id),
    client.getAgent(input.controllerAgentId),
    client.getProject(input.projectId),
    client.listRoutines(input.company.id),
  ]);
  if (company.id !== input.company.id || company.name !== input.company.name || company.status !== "active") {
    throw new PaperclipRoutinesError("paperclip_company_mismatch");
  }
  if (agent.status === "pending_approval") throw new PaperclipRoutinesError("paperclip_agent_approval_required");
  if (agent.id !== input.controllerAgentId || agent.companyId !== input.company.id || agent.name !== input.controller ||
    agent.role !== "devops" || agent.adapterType !== "process" || agent.budgetMonthlyCents !== 0 || agent.status !== "paused") {
    throw new PaperclipRoutinesError("paperclip_agent_mismatch");
  }
  if (project.id !== input.projectId || project.companyId !== input.company.id || project.archivedAt != null ||
    !["backlog", "planned", "in_progress"].includes(project.status)) {
    throw new PaperclipRoutinesError("paperclip_project_mismatch");
  }
  const matches = routines.filter((routine) => routine.title === spec.title);
  if (matches.length > 1) throw new PaperclipRoutinesError("paperclip_routine_drift");
  let routineId: string;
  let disposition: "created" | "reused";
  const existing = matches[0];
  if (existing === undefined) {
    const { key: _key, trigger: _trigger, contractDigest: _contractDigest, ...createInput } = spec;
    const created = await client.createRoutine(input.company.id, createInput);
    routineId = created.id;
    disposition = "created";
  } else {
    routineId = existing.id;
    disposition = "reused";
  }
  let detail = await client.getRoutine(routineId);
  if (detail.id !== routineId || !coreMatches(detail, input, spec)) {
    throw new PaperclipRoutinesError("paperclip_routine_drift");
  }
  if (detail.triggers.length === 0) {
    await client.createScheduleTrigger(routineId, spec.trigger);
    detail = await client.getRoutine(routineId);
  }
  if (detail.id !== routineId || !coreMatches(detail, input, spec) || !triggerMatches(detail, spec)) {
    throw new PaperclipRoutinesError("paperclip_routine_drift");
  }
  return result(input, spec, "applied", disposition);
}

type Environment = Readonly<Record<string, string | undefined>>;
type FetchImplementation = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class PaperclipRestRoutinesClient implements PaperclipRoutinesClient {
  readonly #apiBase: string;
  readonly #token: string;

  constructor(environment: Environment, private readonly fetchImplementation: FetchImplementation = fetch) {
    const apiBase = environment["PAPERCLIP_API_URL"];
    const token = environment["PAPERCLIP_API_KEY"];
    if (apiBase === undefined || token === undefined || token.length < 20 || token.length > 4_096 || /[\r\n]/u.test(token)) {
      throw new PaperclipRoutinesError("paperclip_identity_unavailable");
    }
    let url: URL;
    try {
      url = new URL(apiBase);
    } catch {
      throw new PaperclipRoutinesError("paperclip_identity_unavailable");
    }
    const loopback = url.protocol === "http:" && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !loopback) || url.username || url.password || url.search || url.hash) {
      throw new PaperclipRoutinesError("paperclip_identity_unavailable");
    }
    this.#apiBase = url.toString().replace(/\/+$/u, "");
    this.#token = token;
  }

  async #request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.#apiBase}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.#token}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new PaperclipRoutinesError("paperclip_api_rejected");
    }
    if (response.status !== (method === "POST" ? 201 : 200)) {
      await response.body?.cancel();
      throw new PaperclipRoutinesError("paperclip_api_rejected");
    }
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && (!/^[0-9]+$/u.test(contentLength) || Number(contentLength) > 2_097_152)) {
      await response.body?.cancel();
      throw new PaperclipRoutinesError("paperclip_response_invalid");
    }
    let source: string;
    try {
      source = await response.text();
    } catch {
      throw new PaperclipRoutinesError("paperclip_response_invalid");
    }
    if (Buffer.byteLength(source, "utf8") > 2_097_152) throw new PaperclipRoutinesError("paperclip_response_invalid");
    try {
      return JSON.parse(source) as unknown;
    } catch {
      throw new PaperclipRoutinesError("paperclip_response_invalid");
    }
  }

  async getCompany(companyId: string): Promise<{ readonly id: string; readonly name: string; readonly status?: string }> {
    const value = await this.#request("GET", `/api/companies/${encodeURIComponent(companyId)}`);
    if (!isRecord(value) || typeof value["id"] !== "string" || typeof value["name"] !== "string" ||
      (value["status"] !== undefined && typeof value["status"] !== "string")) {
      throw new PaperclipRoutinesError("paperclip_response_invalid");
    }
    return { id: value["id"], name: value["name"], ...(typeof value["status"] === "string" ? { status: value["status"] } : {}) };
  }

  async getAgent(agentId: string): Promise<Awaited<ReturnType<PaperclipRoutinesClient["getAgent"]>>> {
    const value = await this.#request("GET", `/api/agents/${encodeURIComponent(agentId)}`);
    if (!isRecord(value) || typeof value["id"] !== "string" || typeof value["companyId"] !== "string" ||
      typeof value["name"] !== "string" || typeof value["role"] !== "string" ||
      typeof value["adapterType"] !== "string" || !Number.isSafeInteger(value["budgetMonthlyCents"]) ||
      typeof value["status"] !== "string") throw new PaperclipRoutinesError("paperclip_response_invalid");
    return value as unknown as Awaited<ReturnType<PaperclipRoutinesClient["getAgent"]>>;
  }

  async getProject(projectId: string): Promise<Awaited<ReturnType<PaperclipRoutinesClient["getProject"]>>> {
    const value = await this.#request("GET", `/api/projects/${encodeURIComponent(projectId)}`);
    if (!isRecord(value) || typeof value["id"] !== "string" || typeof value["companyId"] !== "string" ||
      typeof value["status"] !== "string" ||
      (value["archivedAt"] !== undefined && value["archivedAt"] !== null && typeof value["archivedAt"] !== "string")) {
      throw new PaperclipRoutinesError("paperclip_response_invalid");
    }
    return value as unknown as Awaited<ReturnType<PaperclipRoutinesClient["getProject"]>>;
  }

  async listRoutines(companyId: string): Promise<readonly { readonly id: string; readonly title: string }[]> {
    const value = await this.#request("GET", `/api/companies/${encodeURIComponent(companyId)}/routines`);
    if (!Array.isArray(value)) throw new PaperclipRoutinesError("paperclip_response_invalid");
    return value.map((routine) => {
      if (!isRecord(routine) || typeof routine["id"] !== "string" || typeof routine["title"] !== "string") {
        throw new PaperclipRoutinesError("paperclip_response_invalid");
      }
      return { id: routine["id"], title: routine["title"] };
    });
  }

  async createRoutine(
    companyId: string,
    input: Omit<RoutineSpec, "key" | "trigger" | "contractDigest">,
  ): Promise<{ readonly id: string }> {
    const value = await this.#request("POST", `/api/companies/${encodeURIComponent(companyId)}/routines`, input);
    if (!isRecord(value) || typeof value["id"] !== "string") throw new PaperclipRoutinesError("paperclip_response_invalid");
    return { id: value["id"] };
  }

  async getRoutine(routineId: string): Promise<PaperclipRoutineDetail> {
    const value = await this.#request("GET", `/api/routines/${encodeURIComponent(routineId)}`);
    if (!isRecord(value) || typeof value["id"] !== "string" || typeof value["companyId"] !== "string" ||
      (value["projectId"] !== null && typeof value["projectId"] !== "string") ||
      (value["folderId"] !== undefined && value["folderId"] !== null && typeof value["folderId"] !== "string") ||
      (value["goalId"] !== null && typeof value["goalId"] !== "string") ||
      (value["parentIssueId"] !== null && typeof value["parentIssueId"] !== "string") ||
      typeof value["title"] !== "string" || (value["description"] !== null && typeof value["description"] !== "string") ||
      (value["assigneeAgentId"] !== null && typeof value["assigneeAgentId"] !== "string") ||
      typeof value["priority"] !== "string" || typeof value["status"] !== "string" ||
      typeof value["concurrencyPolicy"] !== "string" || typeof value["catchUpPolicy"] !== "string" ||
      !Array.isArray(value["variables"]) || !Array.isArray(value["triggers"])) {
      throw new PaperclipRoutinesError("paperclip_response_invalid");
    }
    for (const trigger of value["triggers"]) {
      if (!isRecord(trigger) || typeof trigger["id"] !== "string" || typeof trigger["kind"] !== "string" ||
        (trigger["label"] !== null && typeof trigger["label"] !== "string") || typeof trigger["enabled"] !== "boolean" ||
        (trigger["cronExpression"] !== null && typeof trigger["cronExpression"] !== "string") ||
        (trigger["timezone"] !== null && typeof trigger["timezone"] !== "string") ||
        (trigger["signingMode"] !== undefined && trigger["signingMode"] !== null &&
          typeof trigger["signingMode"] !== "string") ||
        (trigger["replayWindowSec"] !== undefined && trigger["replayWindowSec"] !== null &&
          !Number.isSafeInteger(trigger["replayWindowSec"]))) {
        throw new PaperclipRoutinesError("paperclip_response_invalid");
      }
    }
    return value as unknown as PaperclipRoutineDetail;
  }

  async createScheduleTrigger(routineId: string, input: RoutineSpec["trigger"]): Promise<void> {
    const value = await this.#request("POST", `/api/routines/${encodeURIComponent(routineId)}/triggers`, input);
    if (!isRecord(value) || !isRecord(value["trigger"]) || typeof value["trigger"]["id"] !== "string") {
      throw new PaperclipRoutinesError("paperclip_response_invalid");
    }
  }
}
