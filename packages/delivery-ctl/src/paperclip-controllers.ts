import { createHash } from "node:crypto";
import { isAbsolute, join, normalize } from "node:path";

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

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const controllerEntry = "bin/controller/index.js";
const legacyControllerEntry = "dist/services/controller/src/main.js";

export interface PaperclipControllersInput {
  readonly schemaVersion: 1;
  readonly company: { readonly id: string; readonly name: CompanyName };
  readonly controller: ControllerName;
  readonly runtimeRoot: string;
  readonly mutationAllowed: true;
}

export interface ControllerContract {
  readonly schemaVersion: 1;
  readonly name: ControllerName;
  readonly mode: "company-delivery";
  readonly scope: { readonly companies: readonly [CompanyName] };
  readonly runtime: { readonly deterministic: true };
}

interface ControllerSpec {
  readonly name: ControllerName;
  readonly role: "devops";
  readonly title: "Flama Delivery Controller";
  readonly adapterType: "process";
  readonly adapterConfig: {
    readonly command: "node";
    readonly args: readonly [typeof controllerEntry];
    readonly cwd: string;
    readonly timeoutSec: 300;
    readonly graceSec: 15;
  };
  readonly desiredSkills: readonly [string];
  readonly budgetMonthlyCents: 0;
  readonly permissions: {
    readonly canCreateAgents: false;
    readonly canCreateSkills: false;
    readonly canAssignTasks: false;
  };
  readonly metadata: {
    readonly managedBy: "flama-delivery-platform";
    readonly topologyVersion: 2;
    readonly contractDigest: string;
  };
}

export interface PaperclipAgent {
  readonly id: string;
  readonly companyId: string;
  readonly name: string;
  readonly role: string;
  readonly title?: string | null;
  readonly adapterType: string;
  readonly adapterConfig: Readonly<Record<string, unknown>>;
  readonly desiredSkills?: readonly unknown[];
  readonly budgetMonthlyCents: number;
  readonly permissions?: Readonly<Record<string, unknown>> | null;
  readonly metadata?: Readonly<Record<string, unknown>> | null;
  readonly status: string;
}

export interface PaperclipControllersClient {
  getCompany(companyId: string): Promise<{
    readonly id: string;
    readonly name: string;
    readonly status?: string;
    readonly requireBoardApprovalForNewAgents?: boolean;
  }>;
  listAgents(companyId: string): Promise<readonly PaperclipAgent[]>;
  listSkills(companyId: string): Promise<readonly { readonly key: string; readonly name: string }[]>;
  createAgent(companyId: string, agent: ControllerSpec): Promise<PaperclipAgent>;
  updateAgent(agentId: string, agent: Pick<ControllerSpec, "adapterConfig" | "metadata">): Promise<PaperclipAgent>;
  getAgent(agentId: string): Promise<PaperclipAgent>;
  getAgentSkills(agentId: string): Promise<{
    readonly adapterType: string;
    readonly supported: boolean;
    readonly mode: string;
    readonly desiredSkills: readonly string[];
  }>;
  pauseAgent(agentId: string): Promise<PaperclipAgent>;
}

export interface PaperclipControllersResult {
  readonly schemaVersion: 1;
  readonly status: "planned" | "applied";
  readonly controller: ControllerName;
  readonly disposition: "planned" | "created" | "migrated" | "reused";
  readonly initialStatus: "paused";
  readonly budgetMonthlyCents: 0;
  readonly contractDigest: string;
}

export type PaperclipControllersErrorCode =
  | "paperclip_agent_approval_required"
  | "paperclip_agent_drift"
  | "paperclip_api_rejected"
  | "paperclip_company_mismatch"
  | "paperclip_contract_invalid"
  | "paperclip_identity_unavailable"
  | "paperclip_response_invalid"
  | "paperclip_skill_unavailable"
  | "paperclip_scope_invalid";

export class PaperclipControllersError extends Error {
  constructor(readonly code: PaperclipControllersErrorCode) {
    super("Paperclip controller provisioning rejected");
    this.name = "PaperclipControllersError";
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(
      ([key, nested]) => [key, stableValue(nested)],
    ));
  }
  return value;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex")}`;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function adapterMatches(observed: Readonly<Record<string, unknown>>, expected: ControllerSpec): boolean {
  const skillSync = observed["paperclipSkillSync"];
  if (typeof skillSync !== "object" || skillSync === null || Array.isArray(skillSync)) return false;
  const base = Object.fromEntries(Object.entries(observed).filter(([key]) => key !== "paperclipSkillSync"));
  return sameJson(base, expected.adapterConfig) &&
    sameJson(Object.keys(skillSync).sort(), ["desiredSkills"]) &&
    sameJson(Reflect.get(skillSync, "desiredSkills"), expected.desiredSkills);
}

function validateInput(input: PaperclipControllersInput, contract: ControllerContract): void {
  if (
    input.schemaVersion !== 1 || input.mutationAllowed !== true ||
    expectedControllers[input.company.name] !== input.controller || !uuidPattern.test(input.company.id) ||
    !isAbsolute(input.runtimeRoot) || normalize(input.runtimeRoot) !== input.runtimeRoot ||
    contract.schemaVersion !== 1 || contract.name !== input.controller || contract.mode !== "company-delivery" ||
    contract.scope.companies.length !== 1 || contract.scope.companies[0] !== input.company.name ||
    contract.runtime.deterministic !== true
  ) throw new PaperclipControllersError("paperclip_scope_invalid");
}

function spec(
  input: PaperclipControllersInput,
  contract: ControllerContract,
  skillKey = "flama-paperclip-delivery",
): ControllerSpec {
  validateInput(input, contract);
  return {
    name: input.controller,
    role: "devops",
    title: "Flama Delivery Controller",
    adapterType: "process",
    adapterConfig: {
      command: "node",
      args: [controllerEntry],
      cwd: input.runtimeRoot,
      timeoutSec: 300,
      graceSec: 15,
    },
    desiredSkills: [skillKey],
    budgetMonthlyCents: 0,
    permissions: { canCreateAgents: false, canCreateSkills: false, canAssignTasks: false },
    metadata: {
      managedBy: "flama-delivery-platform",
      topologyVersion: 2,
      contractDigest: digest(contract),
    },
  };
}

function matches(agent: PaperclipAgent, companyId: string, expected: ControllerSpec): boolean {
  const permissions = agent.permissions ?? {};
  return agent.companyId === companyId && agent.name === expected.name && agent.role === expected.role &&
    agent.title === expected.title && agent.adapterType === expected.adapterType &&
    adapterMatches(agent.adapterConfig, expected) &&
    agent.budgetMonthlyCents === 0 &&
    permissions["canCreateAgents"] === false && permissions["canCreateSkills"] === false &&
    permissions["canAssignTasks"] === false && sameJson(agent.metadata ?? {}, expected.metadata);
}

function matchesLegacySourceEntrypoint(
  agent: PaperclipAgent,
  companyId: string,
  expected: ControllerSpec,
): boolean {
  const legacy = {
    ...expected,
    adapterConfig: { ...expected.adapterConfig, args: [legacyControllerEntry] },
    metadata: { ...expected.metadata, topologyVersion: 1 },
  } as unknown as ControllerSpec;
  return matches(agent, companyId, legacy);
}

function result(
  status: "planned" | "applied",
  expected: ControllerSpec,
  disposition: "planned" | "created" | "migrated" | "reused",
): PaperclipControllersResult {
  return {
    schemaVersion: 1,
    status,
    controller: expected.name,
    disposition,
    initialStatus: "paused",
    budgetMonthlyCents: 0,
    contractDigest: expected.metadata.contractDigest,
  };
}

export function planPaperclipControllers(
  input: PaperclipControllersInput,
  contract: ControllerContract,
): PaperclipControllersResult {
  return result("planned", spec(input, contract), "planned");
}

export async function applyPaperclipControllers(
  input: PaperclipControllersInput,
  contract: ControllerContract,
  client: PaperclipControllersClient,
): Promise<PaperclipControllersResult> {
  validateInput(input, contract);
  const company = await client.getCompany(input.company.id);
  if (company.id !== input.company.id || company.name !== input.company.name || company.status === "archived") {
    throw new PaperclipControllersError("paperclip_company_mismatch");
  }
  const namedSkills = (await client.listSkills(input.company.id)).filter(
    ({ name }) => name === "flama-paperclip-delivery",
  );
  if (namedSkills.length !== 1 || namedSkills[0] === undefined || namedSkills[0].key.length === 0) {
    throw new PaperclipControllersError("paperclip_skill_unavailable");
  }
  const expected = spec(input, contract, namedSkills[0].key);
  const named = (await client.listAgents(input.company.id)).filter(({ name }) => name === expected.name);
  if (named.length > 1) throw new PaperclipControllersError("paperclip_agent_drift");

  let agent: PaperclipAgent;
  let disposition: "created" | "migrated" | "reused";
  const existing = named[0];
  if (existing === undefined) {
    if (company.requireBoardApprovalForNewAgents === true) {
      throw new PaperclipControllersError("paperclip_agent_approval_required");
    }
    agent = await client.createAgent(input.company.id, expected);
    disposition = "created";
  } else {
    agent = existing;
    disposition = "reused";
  }

  if (!matches(agent, input.company.id, expected) && matchesLegacySourceEntrypoint(agent, input.company.id, expected)) {
    if (agent.status === "idle") agent = await client.pauseAgent(agent.id);
    if (agent.status !== "paused") throw new PaperclipControllersError("paperclip_agent_drift");
    agent = await client.updateAgent(agent.id, {
      adapterConfig: {
        ...expected.adapterConfig,
        paperclipSkillSync: { desiredSkills: expected.desiredSkills },
      } as unknown as ControllerSpec["adapterConfig"],
      metadata: expected.metadata,
    });
    disposition = "migrated";
  }
  if (!matches(agent, input.company.id, expected)) {
    throw new PaperclipControllersError("paperclip_agent_drift");
  }
  if (agent.status === "idle") agent = await client.pauseAgent(agent.id);
  if (agent.status !== "paused") throw new PaperclipControllersError("paperclip_agent_drift");

  const observed = await client.getAgent(agent.id);
  if (!matches(observed, input.company.id, expected) || observed.status !== "paused") {
    throw new PaperclipControllersError("paperclip_agent_drift");
  }
  const skillSnapshot = await client.getAgentSkills(agent.id);
  if (
    skillSnapshot.adapterType !== "process" || skillSnapshot.supported !== false ||
    skillSnapshot.mode !== "unsupported" || !sameJson(skillSnapshot.desiredSkills, expected.desiredSkills)
  ) throw new PaperclipControllersError("paperclip_agent_drift");
  return result("applied", expected, disposition);
}

type Environment = Readonly<Record<string, string | undefined>>;
type FetchImplementation = (input: string | URL, init?: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class PaperclipRestControllersClient implements PaperclipControllersClient {
  readonly #apiBase: string;
  readonly #token: string;

  constructor(environment: Environment, private readonly fetchImplementation: FetchImplementation = fetch) {
    const apiBase = environment["PAPERCLIP_API_URL"];
    const token = environment["PAPERCLIP_API_KEY"];
    if (apiBase === undefined || token === undefined || token.length < 20 || token.length > 4_096 || /[\r\n]/u.test(token)) {
      throw new PaperclipControllersError("paperclip_identity_unavailable");
    }
    let url: URL;
    try { url = new URL(apiBase); } catch { throw new PaperclipControllersError("paperclip_identity_unavailable"); }
    const localHttp = url.protocol === "http:" && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !localHttp) || url.username || url.password || url.search || url.hash) {
      throw new PaperclipControllersError("paperclip_identity_unavailable");
    }
    this.#apiBase = url.toString().replace(/\/+$/u, "");
    this.#token = token;
  }

  async #request(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<unknown> {
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
    } catch { throw new PaperclipControllersError("paperclip_api_rejected"); }
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel();
      throw new PaperclipControllersError("paperclip_api_rejected");
    }
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && (!/^[0-9]+$/u.test(contentLength) || Number(contentLength) > 2_097_152)) {
      await response.body?.cancel();
      throw new PaperclipControllersError("paperclip_response_invalid");
    }
    let source: string;
    try { source = await response.text(); } catch { throw new PaperclipControllersError("paperclip_response_invalid"); }
    if (Buffer.byteLength(source, "utf8") > 2_097_152) {
      throw new PaperclipControllersError("paperclip_response_invalid");
    }
    try { return JSON.parse(source) as unknown; } catch {
      throw new PaperclipControllersError("paperclip_response_invalid");
    }
  }

  #agent(value: unknown): PaperclipAgent {
    if (!isRecord(value) || typeof value["id"] !== "string" || typeof value["companyId"] !== "string" ||
      typeof value["name"] !== "string" || typeof value["role"] !== "string" ||
      typeof value["adapterType"] !== "string" || !isRecord(value["adapterConfig"]) ||
      !Number.isInteger(value["budgetMonthlyCents"]) || typeof value["status"] !== "string") {
      throw new PaperclipControllersError("paperclip_response_invalid");
    }
    return value as unknown as PaperclipAgent;
  }

  async getCompany(companyId: string): ReturnType<PaperclipControllersClient["getCompany"]> {
    const value = await this.#request("GET", `/api/companies/${encodeURIComponent(companyId)}`);
    if (!isRecord(value) || typeof value["id"] !== "string" || typeof value["name"] !== "string" ||
      (value["requireBoardApprovalForNewAgents"] !== undefined &&
        typeof value["requireBoardApprovalForNewAgents"] !== "boolean")) {
      throw new PaperclipControllersError("paperclip_response_invalid");
    }
    return value as unknown as Awaited<ReturnType<PaperclipControllersClient["getCompany"]>>;
  }

  async listAgents(companyId: string): Promise<readonly PaperclipAgent[]> {
    const value = await this.#request("GET", `/api/companies/${encodeURIComponent(companyId)}/agents`);
    if (!Array.isArray(value)) throw new PaperclipControllersError("paperclip_response_invalid");
    return value.map((entry) => this.#agent(entry));
  }

  async listSkills(companyId: string): Promise<readonly { readonly key: string; readonly name: string }[]> {
    const value = await this.#request("GET", `/api/companies/${encodeURIComponent(companyId)}/skills`);
    if (!Array.isArray(value) || value.some((entry) =>
      !isRecord(entry) || typeof entry["key"] !== "string" || typeof entry["name"] !== "string"
    )) throw new PaperclipControllersError("paperclip_response_invalid");
    return value as Array<{ readonly key: string; readonly name: string }>;
  }

  async createAgent(companyId: string, agent: ControllerSpec): Promise<PaperclipAgent> {
    return this.#agent(await this.#request("POST", `/api/companies/${encodeURIComponent(companyId)}/agents`, agent));
  }

  async updateAgent(
    agentId: string,
    agent: Pick<ControllerSpec, "adapterConfig" | "metadata">,
  ): Promise<PaperclipAgent> {
    return this.#agent(await this.#request("PATCH", `/api/agents/${encodeURIComponent(agentId)}`, {
      ...agent,
      replaceAdapterConfig: true,
    }));
  }

  async getAgent(agentId: string): Promise<PaperclipAgent> {
    return this.#agent(await this.#request("GET", `/api/agents/${encodeURIComponent(agentId)}`));
  }

  async getAgentSkills(agentId: string): ReturnType<PaperclipControllersClient["getAgentSkills"]> {
    const value = await this.#request("GET", `/api/agents/${encodeURIComponent(agentId)}/skills`);
    if (!isRecord(value) || typeof value["adapterType"] !== "string" ||
      typeof value["supported"] !== "boolean" || typeof value["mode"] !== "string" ||
      !Array.isArray(value["desiredSkills"]) || value["desiredSkills"].some((entry) => typeof entry !== "string")) {
      throw new PaperclipControllersError("paperclip_response_invalid");
    }
    return value as unknown as Awaited<ReturnType<PaperclipControllersClient["getAgentSkills"]>>;
  }

  async pauseAgent(agentId: string): Promise<PaperclipAgent> {
    return this.#agent(await this.#request("POST", `/api/agents/${encodeURIComponent(agentId)}/pause`, {}));
  }
}

export function controllerRuntimeEntry(runtimeRoot: string): string {
  return join(runtimeRoot, controllerEntry);
}
