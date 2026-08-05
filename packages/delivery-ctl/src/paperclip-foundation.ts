import { createHash } from "node:crypto";

const lifecycleIds = ["project-bootstrap", "feature-fix", "release-deployment"] as const;
type LifecycleId = typeof lifecycleIds[number];
type CompanyName = "Private" | "// Navigaite" | "Edilio";
type ControllerName =
  | "maxbec-delivery-controller"
  | "navigaite-delivery-controller"
  | "edilio-delivery-controller";

const expectedControllers: Readonly<Record<CompanyName, ControllerName>> = {
  Private: "maxbec-delivery-controller",
  "// Navigaite": "navigaite-delivery-controller",
  Edilio: "edilio-delivery-controller",
};

export interface PaperclipFoundationInput {
  readonly schemaVersion: 1;
  readonly company: { readonly id: string; readonly name: CompanyName };
  readonly controller: ControllerName;
  readonly mutationAllowed: true;
}

export interface LifecycleTransitionContract {
  readonly from: string;
  readonly to: string;
  readonly trigger: string;
  readonly authority: string;
  readonly evidence: readonly string[];
}

export interface LifecycleContract {
  readonly schemaVersion: 1;
  readonly id: LifecycleId;
  readonly initialState: string;
  readonly terminalStates: readonly string[];
  readonly states: readonly string[];
  readonly transitions: readonly LifecycleTransitionContract[];
}

interface PipelineStageSpec {
  readonly key: string;
  readonly name: string;
  readonly kind: "working" | "done" | "cancelled";
  readonly position: number;
  readonly config: Readonly<Record<string, unknown>>;
}

interface PipelineTransitionSpec {
  readonly fromStageKey: string;
  readonly toStageKey: string;
  readonly label: string;
}

interface PipelineSpec {
  readonly lifecycle: LifecycleId;
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly contractDigest: string;
  readonly stages: readonly PipelineStageSpec[];
  readonly transitions: readonly PipelineTransitionSpec[];
}

export interface PaperclipPipelineListItem {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly enforceTransitions: boolean;
  readonly archivedAt: string | null;
  readonly openCaseCount: number;
}

export interface PaperclipPipelineDetail {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly enforceTransitions: boolean;
  readonly archivedAt: string | null;
  readonly stages: readonly {
    readonly id: string;
    readonly key: string;
    readonly name: string;
    readonly kind: string;
    readonly position: number;
    readonly config?: Readonly<Record<string, unknown>> | null;
  }[];
  readonly transitions: readonly {
    readonly fromStageId: string;
    readonly toStageId: string;
    readonly label?: string | null;
  }[];
}

export interface PaperclipFoundationClient {
  getCompany(companyId: string): Promise<{ readonly id: string; readonly name: string; readonly status?: string }>;
  listPipelines(companyId: string): Promise<readonly PaperclipPipelineListItem[]>;
  createPipeline(
    companyId: string,
    pipeline: {
      readonly key: string;
      readonly name: string;
      readonly description: string;
      readonly enforceTransitions: false;
      readonly stages: readonly PipelineStageSpec[];
    },
  ): Promise<{ readonly id: string }>;
  getPipeline(pipelineId: string): Promise<PaperclipPipelineDetail>;
  replaceTransitions(
    pipelineId: string,
    input: { readonly transitions: readonly PipelineTransitionSpec[]; readonly enforceTransitions: true },
  ): Promise<void>;
}

export interface PaperclipFoundationResult {
  readonly schemaVersion: 1;
  readonly status: "planned" | "applied";
  readonly pipelines: readonly {
    readonly lifecycle: LifecycleId;
    readonly pipelineKey: string;
    readonly contractDigest: string;
    readonly disposition: "planned" | "created" | "reused";
    readonly stageCount: number;
    readonly transitionCount: number;
  }[];
  readonly summary: { readonly planned: number; readonly created: number; readonly reused: number };
}

export type PaperclipFoundationErrorCode =
  | "paperclip_api_rejected"
  | "paperclip_company_mismatch"
  | "paperclip_contract_invalid"
  | "paperclip_identity_unavailable"
  | "paperclip_pipeline_drift"
  | "paperclip_response_invalid"
  | "paperclip_scope_invalid";

export class PaperclipFoundationError extends Error {
  constructor(readonly code: PaperclipFoundationErrorCode) {
    super("Paperclip foundation rejected");
    this.name = "PaperclipFoundationError";
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === "object" && value !== null) {
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

function stateKey(state: string): string {
  const key = state.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
  if (!/^[a-z][a-z0-9_]{0,119}$/u.test(key)) {
    throw new PaperclipFoundationError("paperclip_contract_invalid");
  }
  return key;
}

function validateLifecycle(contract: LifecycleContract): void {
  const states = new Set(contract.states);
  const terminal = new Set(contract.terminalStates);
  const transitionEdges = new Set(contract.transitions.map(({ from, to }) => `${from}\u0000${to}`));
  if (
    contract.schemaVersion !== 1 ||
    !lifecycleIds.includes(contract.id) ||
    contract.states.length === 0 ||
    states.size !== contract.states.length ||
    !states.has(contract.initialState) ||
    contract.terminalStates.length === 0 ||
    contract.terminalStates.some((state) => !states.has(state)) ||
    new Set(contract.states.map(stateKey)).size !== contract.states.length ||
    contract.states.map(stateKey).includes("flama_cancelled") ||
    contract.transitions.length === 0 ||
    transitionEdges.size !== contract.transitions.length ||
    contract.transitions.some((transition) =>
      !states.has(transition.from) ||
      !states.has(transition.to) ||
      transition.from === transition.to ||
      transition.authority.length === 0 ||
      transition.trigger.length === 0 ||
      transition.evidence.length === 0 ||
      terminal.has(transition.from),
    )
  ) {
    throw new PaperclipFoundationError("paperclip_contract_invalid");
  }
}

function title(value: string): string {
  return value.split("-").map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(" ");
}

function transitionLabel(transition: LifecycleTransitionContract): string {
  const label = `${transition.authority}|${transition.trigger}|${transition.evidence.join(",")}`;
  if (label.length > 200) throw new PaperclipFoundationError("paperclip_contract_invalid");
  return label;
}

function buildPipelineSpec(contract: LifecycleContract): PipelineSpec {
  validateLifecycle(contract);
  const contractDigest = digest(contract);
  const terminal = new Set(contract.terminalStates);
  return {
    lifecycle: contract.id,
    key: `flama-${contract.id}-v${contract.schemaVersion}`,
    name: `Flama ${title(contract.id)}`,
    description: `Managed by flama-delivery-platform; lifecycle=${contract.id}; contract=${contractDigest}`,
    contractDigest,
    stages: [
      ...contract.states.map((state, index) => ({
        key: stateKey(state),
        name: state,
        kind: terminal.has(state) ? "done" as const : "working" as const,
        position: (index + 1) * 100,
        config: {
          requireApproval: false,
          approver: { kind: "any_human" },
          whatHappensHere: `Flama lifecycle state: ${state}. Advance only with authority and evidence required by the pinned platform contract.`,
        },
      })),
      {
        key: "flama_cancelled",
        name: "Cancelled (administrative)",
        kind: "cancelled",
        position: (contract.states.length + 1) * 100,
        config: {
          requireApproval: false,
          approver: { kind: "any_human" },
          whatHappensHere: "Paperclip-required terminal sentinel. No normal lifecycle transition enters this stage; administrative cancellation requires a separately authorized forced transition.",
        },
      },
    ],
    transitions: contract.transitions.map((transition) => ({
      fromStageKey: stateKey(transition.from),
      toStageKey: stateKey(transition.to),
      label: transitionLabel(transition),
    })),
  };
}

function validateScope(input: PaperclipFoundationInput): void {
  if (
    input.schemaVersion !== 1 ||
    input.mutationAllowed !== true ||
    expectedControllers[input.company.name] !== input.controller ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(input.company.id)
  ) {
    throw new PaperclipFoundationError("paperclip_scope_invalid");
  }
}

function specs(contracts: readonly LifecycleContract[]): readonly PipelineSpec[] {
  if (contracts.length !== lifecycleIds.length) {
    throw new PaperclipFoundationError("paperclip_contract_invalid");
  }
  const byId = new Map(contracts.map((contract) => [contract.id, contract]));
  if (byId.size !== lifecycleIds.length) {
    throw new PaperclipFoundationError("paperclip_contract_invalid");
  }
  return lifecycleIds.map((id) => {
    const contract = byId.get(id);
    if (contract === undefined) throw new PaperclipFoundationError("paperclip_contract_invalid");
    return buildPipelineSpec(contract);
  });
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function coreMatches(pipeline: PaperclipPipelineDetail, spec: PipelineSpec): boolean {
  const observedStages = pipeline.stages.map((stage) => ({
    key: stage.key,
    name: stage.name,
    kind: stage.kind,
    position: stage.position,
    config: stage.config ?? {},
  }));
  return pipeline.key === spec.key && pipeline.name === spec.name && pipeline.description === spec.description &&
    pipeline.archivedAt === null && sameJson(observedStages, spec.stages);
}

function observedTransitions(pipeline: PaperclipPipelineDetail): readonly PipelineTransitionSpec[] {
  const keyById = new Map(pipeline.stages.map((stage) => [stage.id, stage.key]));
  return pipeline.transitions.map((transition) => {
    const fromStageKey = keyById.get(transition.fromStageId);
    const toStageKey = keyById.get(transition.toStageId);
    if (fromStageKey === undefined || toStageKey === undefined) {
      throw new PaperclipFoundationError("paperclip_response_invalid");
    }
    return { fromStageKey, toStageKey, label: transition.label ?? "" };
  });
}

function normalizedTransitions(value: readonly PipelineTransitionSpec[]): readonly PipelineTransitionSpec[] {
  return [...value].sort((left, right) =>
    `${left.fromStageKey}\u0000${left.toStageKey}\u0000${left.label}`
      .localeCompare(`${right.fromStageKey}\u0000${right.toStageKey}\u0000${right.label}`),
  );
}

function transitionsMatch(pipeline: PaperclipPipelineDetail, spec: PipelineSpec): boolean {
  return pipeline.enforceTransitions && sameJson(
    normalizedTransitions(observedTransitions(pipeline)),
    normalizedTransitions(spec.transitions),
  );
}

function result(
  status: "planned" | "applied",
  values: readonly PaperclipFoundationResult["pipelines"][number][],
): PaperclipFoundationResult {
  return {
    schemaVersion: 1,
    status,
    pipelines: values,
    summary: {
      planned: values.filter(({ disposition }) => disposition === "planned").length,
      created: values.filter(({ disposition }) => disposition === "created").length,
      reused: values.filter(({ disposition }) => disposition === "reused").length,
    },
  };
}

export function planPaperclipFoundation(
  input: PaperclipFoundationInput,
  contracts: readonly LifecycleContract[],
): PaperclipFoundationResult {
  validateScope(input);
  return result("planned", specs(contracts).map((spec) => ({
    lifecycle: spec.lifecycle,
    pipelineKey: spec.key,
    contractDigest: spec.contractDigest,
    disposition: "planned" as const,
    stageCount: spec.stages.length,
    transitionCount: spec.transitions.length,
  })));
}

export async function applyPaperclipFoundation(
  input: PaperclipFoundationInput,
  contracts: readonly LifecycleContract[],
  client: PaperclipFoundationClient,
): Promise<PaperclipFoundationResult> {
  validateScope(input);
  const company = await client.getCompany(input.company.id);
  if (company.id !== input.company.id || company.name !== input.company.name || company.status === "archived") {
    throw new PaperclipFoundationError("paperclip_company_mismatch");
  }

  const pipelineSpecs = specs(contracts);
  const listed = await client.listPipelines(input.company.id);
  const outcomes: PaperclipFoundationResult["pipelines"][number][] = [];
  for (const spec of pipelineSpecs) {
    const matches = listed.filter((pipeline) => pipeline.key === spec.key);
    if (matches.length > 1) throw new PaperclipFoundationError("paperclip_pipeline_drift");
    let pipelineId: string;
    let disposition: "created" | "reused";
    if (matches.length === 0) {
      const created = await client.createPipeline(input.company.id, {
        key: spec.key,
        name: spec.name,
        description: spec.description,
        enforceTransitions: false,
        stages: spec.stages,
      });
      pipelineId = created.id;
      disposition = "created";
    } else {
      const matched = matches[0];
      if (matched === undefined || matched.archivedAt !== null || matched.openCaseCount !== 0) {
        throw new PaperclipFoundationError("paperclip_pipeline_drift");
      }
      pipelineId = matched.id;
      disposition = "reused";
    }

    let detail = await client.getPipeline(pipelineId);
    if (!coreMatches(detail, spec)) throw new PaperclipFoundationError("paperclip_pipeline_drift");
    if (!transitionsMatch(detail, spec)) {
      const observed = observedTransitions(detail);
      if (observed.length > 0) throw new PaperclipFoundationError("paperclip_pipeline_drift");
      await client.replaceTransitions(pipelineId, { transitions: spec.transitions, enforceTransitions: true });
      detail = await client.getPipeline(pipelineId);
    }
    if (!coreMatches(detail, spec) || !transitionsMatch(detail, spec)) {
      throw new PaperclipFoundationError("paperclip_pipeline_drift");
    }
    outcomes.push({
      lifecycle: spec.lifecycle,
      pipelineKey: spec.key,
      contractDigest: spec.contractDigest,
      disposition,
      stageCount: spec.stages.length,
      transitionCount: spec.transitions.length,
    });
  }
  return result("applied", outcomes);
}

type Environment = Readonly<Record<string, string | undefined>>;
type FetchImplementation = (input: string | URL, init?: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class PaperclipRestFoundationClient implements PaperclipFoundationClient {
  readonly #apiBase: string;
  readonly #token: string;

  constructor(environment: Environment, private readonly fetchImplementation: FetchImplementation = fetch) {
    const apiBase = environment["PAPERCLIP_API_URL"];
    const token = environment["PAPERCLIP_API_KEY"];
    if (apiBase === undefined || token === undefined || token.length < 20 || token.length > 4_096 || /[\r\n]/u.test(token)) {
      throw new PaperclipFoundationError("paperclip_identity_unavailable");
    }
    let url: URL;
    try {
      url = new URL(apiBase);
    } catch {
      throw new PaperclipFoundationError("paperclip_identity_unavailable");
    }
    const localHttp = url.protocol === "http:" && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !localHttp) || url.username || url.password || url.search || url.hash) {
      throw new PaperclipFoundationError("paperclip_identity_unavailable");
    }
    this.#apiBase = url.toString().replace(/\/+$/u, "");
    this.#token = token;
  }

  async #request(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<unknown> {
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
      throw new PaperclipFoundationError("paperclip_api_rejected");
    }
    const expected = method === "POST" ? 201 : 200;
    if (response.status !== expected) {
      await response.body?.cancel();
      throw new PaperclipFoundationError("paperclip_api_rejected");
    }
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && (!/^[0-9]+$/u.test(contentLength) || Number(contentLength) > 2_097_152)) {
      await response.body?.cancel();
      throw new PaperclipFoundationError("paperclip_response_invalid");
    }
    let source: string;
    try {
      source = await response.text();
    } catch {
      throw new PaperclipFoundationError("paperclip_response_invalid");
    }
    if (Buffer.byteLength(source, "utf8") > 2_097_152) {
      throw new PaperclipFoundationError("paperclip_response_invalid");
    }
    try {
      return JSON.parse(source) as unknown;
    } catch {
      throw new PaperclipFoundationError("paperclip_response_invalid");
    }
  }

  async getCompany(companyId: string): Promise<{ readonly id: string; readonly name: string; readonly status?: string }> {
    const value = await this.#request("GET", `/api/companies/${encodeURIComponent(companyId)}`);
    if (!isRecord(value) || typeof value["id"] !== "string" || typeof value["name"] !== "string") {
      throw new PaperclipFoundationError("paperclip_response_invalid");
    }
    const status = value["status"];
    return {
      id: value["id"],
      name: value["name"],
      ...(typeof status === "string" ? { status } : {}),
    };
  }

  async listPipelines(companyId: string): Promise<readonly PaperclipPipelineListItem[]> {
    const value = await this.#request("GET", `/api/companies/${encodeURIComponent(companyId)}/pipelines`);
    if (!Array.isArray(value)) throw new PaperclipFoundationError("paperclip_response_invalid");
    return value.map((pipeline) => {
      if (
        !isRecord(pipeline) || typeof pipeline["id"] !== "string" || typeof pipeline["key"] !== "string" ||
        typeof pipeline["name"] !== "string" ||
        (pipeline["description"] !== null && typeof pipeline["description"] !== "string") ||
        typeof pipeline["enforceTransitions"] !== "boolean" ||
        (pipeline["archivedAt"] !== null && typeof pipeline["archivedAt"] !== "string") ||
        !Number.isInteger(pipeline["openCaseCount"])
      ) throw new PaperclipFoundationError("paperclip_response_invalid");
      return pipeline as unknown as PaperclipPipelineListItem;
    });
  }

  async createPipeline(
    companyId: string,
    pipeline: {
      readonly key: string;
      readonly name: string;
      readonly description: string;
      readonly enforceTransitions: false;
      readonly stages: readonly PipelineStageSpec[];
    },
  ): Promise<{ readonly id: string }> {
    const value = await this.#request(
      "POST",
      `/api/companies/${encodeURIComponent(companyId)}/pipelines`,
      pipeline,
    );
    if (!isRecord(value) || typeof value["id"] !== "string") {
      throw new PaperclipFoundationError("paperclip_response_invalid");
    }
    return { id: value["id"] };
  }

  async getPipeline(pipelineId: string): Promise<PaperclipPipelineDetail> {
    const value = await this.#request("GET", `/api/pipelines/${encodeURIComponent(pipelineId)}`);
    if (
      !isRecord(value) || typeof value["id"] !== "string" || typeof value["key"] !== "string" ||
      typeof value["name"] !== "string" ||
      (value["description"] !== null && typeof value["description"] !== "string") ||
      typeof value["enforceTransitions"] !== "boolean" ||
      (value["archivedAt"] !== null && typeof value["archivedAt"] !== "string") ||
      !Array.isArray(value["stages"]) || !Array.isArray(value["transitions"])
    ) {
      throw new PaperclipFoundationError("paperclip_response_invalid");
    }
    const stages = value["stages"];
    const transitions = value["transitions"];
    if (stages.some((stage) =>
      !isRecord(stage) || typeof stage["id"] !== "string" || typeof stage["key"] !== "string" ||
      typeof stage["name"] !== "string" || typeof stage["kind"] !== "string" ||
      !Number.isInteger(stage["position"]) ||
      (stage["config"] !== null && stage["config"] !== undefined && !isRecord(stage["config"])),
    ) || transitions.some((transition) =>
      !isRecord(transition) || typeof transition["fromStageId"] !== "string" ||
      typeof transition["toStageId"] !== "string" ||
      (transition["label"] !== null && transition["label"] !== undefined && typeof transition["label"] !== "string"),
    )) throw new PaperclipFoundationError("paperclip_response_invalid");
    return {
      id: value["id"],
      key: value["key"],
      name: value["name"],
      description: value["description"],
      enforceTransitions: value["enforceTransitions"],
      archivedAt: value["archivedAt"],
      stages,
      transitions,
    } as unknown as PaperclipPipelineDetail;
  }

  async replaceTransitions(
    pipelineId: string,
    input: { readonly transitions: readonly PipelineTransitionSpec[]; readonly enforceTransitions: true },
  ): Promise<void> {
    await this.#request("PUT", `/api/pipelines/${encodeURIComponent(pipelineId)}/transitions`, input);
  }
}
