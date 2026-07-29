import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const controllerNames = [
  "maxbec-delivery-controller",
  "navigaite-delivery-controller",
  "edilio-delivery-controller",
] as const;
type ControllerName = typeof controllerNames[number];
type CompanyName = "Private" | "// Navigaite" | "Edilio";

const expectedCompanies: Readonly<Record<ControllerName, CompanyName>> = {
  "maxbec-delivery-controller": "Private",
  "navigaite-delivery-controller": "// Navigaite",
  "edilio-delivery-controller": "Edilio",
};

type Environment = Readonly<Record<string, string | undefined>>;
type FetchImplementation = (input: string | URL, init?: RequestInit) => Promise<Response>;

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

export interface ControllerRuntimeResult {
  readonly schemaVersion: 1;
  readonly status: "idle";
  readonly contractDigest: string;
}

export type ControllerRuntimeErrorCode =
  | "controller_api_rejected"
  | "controller_assignment_unsupported"
  | "controller_contract_invalid"
  | "controller_identity_invalid"
  | "controller_identity_unavailable"
  | "controller_response_invalid";

export class ControllerRuntimeError extends Error {
  constructor(readonly code: ControllerRuntimeErrorCode) {
    super("controller runtime rejected");
    this.name = "ControllerRuntimeError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
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

function runtimeIdentity(environment: Environment): {
  readonly apiBase: string;
  readonly token: string;
  readonly agentId: string;
  readonly companyId: string;
  readonly runId: string;
} {
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
  identity: ReturnType<typeof runtimeIdentity>,
  endpoint: string,
  fetchImplementation: FetchImplementation,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImplementation(`${identity.apiBase}${endpoint}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${identity.token}`,
        Accept: "application/json",
        "X-Paperclip-Run-Id": identity.runId,
      },
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
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && (!/^[0-9]+$/u.test(contentLength) || Number(contentLength) > 2_097_152)) {
    await response.body?.cancel();
    throw new ControllerRuntimeError("controller_response_invalid");
  }
  let source: string;
  try {
    source = await response.text();
  } catch {
    throw new ControllerRuntimeError("controller_response_invalid");
  }
  if (Buffer.byteLength(source, "utf8") > 2_097_152) {
    throw new ControllerRuntimeError("controller_response_invalid");
  }
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new ControllerRuntimeError("controller_response_invalid");
  }
}

function parseIdentity(value: unknown, runtime: ReturnType<typeof runtimeIdentity>): ControllerIdentity {
  if (
    !isRecord(value) || value["id"] !== runtime.agentId || value["companyId"] !== runtime.companyId ||
    !isControllerName(value["name"]) || value["role"] !== "devops" || value["adapterType"] !== "process" ||
    value["budgetMonthlyCents"] !== 0
  ) throw new ControllerRuntimeError("controller_identity_invalid");
  return value as unknown as ControllerIdentity;
}

function validateContract(value: unknown, identity: ControllerIdentity): ControllerContract {
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

export async function runControllerRuntime(
  environment: Environment,
  repositoryRoot: string,
  fetchImplementation: FetchImplementation = fetch,
): Promise<ControllerRuntimeResult> {
  const runtime = runtimeIdentity(environment);
  const identity = parseIdentity(
    await requestJson(runtime, "/api/agents/me", fetchImplementation),
    runtime,
  );
  let source: string;
  try {
    source = await readFile(join(repositoryRoot, "lifecycles", "controllers", `${identity.name}.json`), "utf8");
  } catch {
    throw new ControllerRuntimeError("controller_contract_invalid");
  }
  let rawContract: unknown;
  try {
    rawContract = JSON.parse(source) as unknown;
  } catch {
    throw new ControllerRuntimeError("controller_contract_invalid");
  }
  const contract = validateContract(rawContract, identity);
  const query = new URLSearchParams({
    assigneeAgentId: runtime.agentId,
    status: "todo,in_progress,in_review,blocked",
    limit: "100",
  });
  const assignments = await requestJson(
    runtime,
    `/api/companies/${encodeURIComponent(runtime.companyId)}/issues?${query.toString()}`,
    fetchImplementation,
  );
  if (!Array.isArray(assignments)) throw new ControllerRuntimeError("controller_response_invalid");
  if (assignments.length > 0) throw new ControllerRuntimeError("controller_assignment_unsupported");
  return { schemaVersion: 1, status: "idle", contractDigest: digest(contract) };
}
