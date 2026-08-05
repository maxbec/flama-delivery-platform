import { createHash } from "node:crypto";
import {
  type PaperclipRoutineCreateInput,
  type PaperclipRoutineDetail,
  type PaperclipWebhookRoutinesClient,
  type PaperclipWebhookSecretMaterial,
} from "./paperclip-routines.js";

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
const webhookUrlSecretName = "PAPERCLIP_ROUTINE_WEBHOOK_URL";
const webhookSecretSecretName = "PAPERCLIP_ROUTINE_WEBHOOK_SECRET";

export interface PaperclipGithubTransitionRoutineContract {
  readonly schemaVersion: 1;
  readonly key: "flama-github-transition-v1";
  readonly title: "Flama GitHub Evidence Transition";
  readonly description: string;
  readonly priority: "high";
  readonly initialStatus: "paused";
  readonly concurrencyPolicy: "always_enqueue";
  readonly catchUpPolicy: "skip_missed";
  readonly execution: {
    readonly command: "transition-external-evidence";
    readonly mode: "paperclip-native";
    readonly authorizationStore: "flama_delivery.external_transition_authorization";
  };
  readonly trigger: {
    readonly kind: "webhook";
    readonly label: "flama-github-transition-v1";
    readonly enabled: true;
    readonly signingMode: "hmac_sha256";
    readonly replayWindowSeconds: 300;
    readonly credentialSource: "infisical-oidc";
  };
}

export interface PaperclipGithubTransitionRoutineInput {
  readonly schemaVersion: 1;
  readonly company: { readonly id: string; readonly name: CompanyName };
  readonly controller: ControllerName;
  readonly controllerAgentId: string;
  readonly projectId: string;
  readonly infisical: {
    readonly sourceOfTruth: true;
    readonly projectId: string;
    readonly environment: string;
    readonly secretPath: string;
    readonly credentialSource: "infisical-oidc";
  };
  readonly paperclipSecretStorageException: {
    readonly key: typeof webhookSecretSecretName;
    readonly destination: "provider_native_secret";
    readonly reason: string;
    readonly owner: string;
    readonly scope: "provider";
    readonly rotationDays: number;
    readonly expiresAt: string;
    readonly reviewAfter: string;
    readonly status: "approved";
  };
  readonly mutationAllowed: true;
}

interface RoutineSpec extends PaperclipRoutineCreateInput {
  readonly key: "flama-github-transition-v1";
  readonly trigger: {
    readonly kind: "webhook";
    readonly label: "flama-github-transition-v1";
    readonly enabled: true;
    readonly signingMode: "hmac_sha256";
    readonly replayWindowSec: 300;
  };
  readonly contractDigest: string;
}

export interface PaperclipGithubTransitionRoutineResult {
  readonly schemaVersion: 1;
  readonly status: "planned" | "applied";
  readonly controller: ControllerName;
  readonly routineKey: "flama-github-transition-v1";
  readonly routineDisposition: "planned" | "created" | "reused";
  readonly triggerDisposition: "planned" | "created" | "reused" | "rotated";
  readonly initialStatus: "paused";
  readonly trigger: {
    readonly kind: "webhook";
    readonly enabled: true;
    readonly signingMode: "hmac_sha256";
    readonly replayWindowSeconds: 300;
  };
  readonly infisicalSynced: boolean;
  readonly contractDigest: string;
  readonly exceptionDigest: string;
}

export interface InfisicalSecretMetadata {
  readonly key: string;
  readonly value: string;
  readonly isEncrypted: false;
}

export interface InfisicalRoutineSecretStore {
  readMetadata(
    mapping: PaperclipGithubTransitionRoutineInput["infisical"],
    secretName: typeof webhookUrlSecretName | typeof webhookSecretSecretName,
  ): Promise<readonly InfisicalSecretMetadata[] | null>;
  upsertSecret(
    mapping: PaperclipGithubTransitionRoutineInput["infisical"],
    secretName: typeof webhookUrlSecretName | typeof webhookSecretSecretName,
    value: string,
    metadata: readonly InfisicalSecretMetadata[],
  ): Promise<void>;
}

export type PaperclipGithubTransitionRoutineErrorCode =
  | "infisical_api_rejected"
  | "infisical_identity_unavailable"
  | "infisical_receipt_invalid"
  | "infisical_response_invalid"
  | "infisical_sync_failed"
  | "paperclip_agent_approval_required"
  | "paperclip_agent_mismatch"
  | "paperclip_company_mismatch"
  | "paperclip_contract_invalid"
  | "paperclip_project_mismatch"
  | "paperclip_routine_drift"
  | "paperclip_scope_invalid"
  | "paperclip_secret_exception_invalid";

export class PaperclipGithubTransitionRoutineError extends Error {
  constructor(readonly code: PaperclipGithubTransitionRoutineErrorCode) {
    super("Paperclip GitHub-transition routine provisioning rejected");
    this.name = "PaperclipGithubTransitionRoutineError";
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

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function validIsoTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validateInput(input: PaperclipGithubTransitionRoutineInput, now: Date): void {
  const exception = input.paperclipSecretStorageException;
  const nowValue = now.getTime();
  const today = Number.isFinite(nowValue) ? now.toISOString().slice(0, 10) : "";
  if (
    input.schemaVersion !== 1 || input.mutationAllowed !== true ||
    companyControllers[input.company.name] !== input.controller || !uuidPattern.test(input.company.id) ||
    !uuidPattern.test(input.controllerAgentId) || !uuidPattern.test(input.projectId) ||
    input.infisical.sourceOfTruth !== true || !uuidPattern.test(input.infisical.projectId) ||
    !/^[a-z][a-z0-9_-]{0,63}$/u.test(input.infisical.environment) ||
    !/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/u.test(input.infisical.secretPath) ||
    input.infisical.secretPath.includes("..") || input.infisical.credentialSource !== "infisical-oidc"
  ) throw new PaperclipGithubTransitionRoutineError("paperclip_scope_invalid");
  if (
    !Number.isFinite(nowValue) || exception.key !== webhookSecretSecretName ||
    exception.destination !== "provider_native_secret" || exception.scope !== "provider" ||
    exception.status !== "approved" || exception.reason.length < 20 || exception.reason.length > 1_000 ||
    exception.owner.length < 1 || exception.owner.length > 120 ||
    !Number.isSafeInteger(exception.rotationDays) || exception.rotationDays < 1 || exception.rotationDays > 365 ||
    !validDate(exception.expiresAt) || !validDate(exception.reviewAfter) ||
    exception.reviewAfter > exception.expiresAt || exception.expiresAt < today || exception.reviewAfter <= today
  ) throw new PaperclipGithubTransitionRoutineError("paperclip_secret_exception_invalid");
}

function validateContract(contract: PaperclipGithubTransitionRoutineContract): void {
  if (
    contract.schemaVersion !== 1 || contract.key !== "flama-github-transition-v1" ||
    contract.title !== "Flama GitHub Evidence Transition" || contract.description.length < 100 ||
    contract.description.length > 2_000 || /[\u0000\r]/u.test(contract.description) ||
    contract.priority !== "high" || contract.initialStatus !== "paused" ||
    contract.concurrencyPolicy !== "always_enqueue" || contract.catchUpPolicy !== "skip_missed" ||
    contract.execution.command !== "transition-external-evidence" || contract.execution.mode !== "paperclip-native" ||
    contract.execution.authorizationStore !== "flama_delivery.external_transition_authorization" ||
    contract.trigger.kind !== "webhook" || contract.trigger.label !== contract.key ||
    contract.trigger.enabled !== true || contract.trigger.signingMode !== "hmac_sha256" ||
    contract.trigger.replayWindowSeconds !== 300 || contract.trigger.credentialSource !== "infisical-oidc"
  ) throw new PaperclipGithubTransitionRoutineError("paperclip_contract_invalid");
}

function routineSpec(
  input: PaperclipGithubTransitionRoutineInput,
  contract: PaperclipGithubTransitionRoutineContract,
  now: Date,
): RoutineSpec {
  validateInput(input, now);
  validateContract(contract);
  const contractDigest = digest(contract);
  return {
    key: contract.key,
    title: contract.title,
    description: `Managed by flama-delivery-platform; key=${contract.key}; contract=${contractDigest}\n\n${contract.description}`,
    projectId: input.projectId,
    assigneeAgentId: input.controllerAgentId,
    priority: contract.priority,
    status: contract.initialStatus,
    concurrencyPolicy: contract.concurrencyPolicy,
    catchUpPolicy: contract.catchUpPolicy,
    variables: [],
    trigger: {
      kind: contract.trigger.kind,
      label: contract.trigger.label,
      enabled: contract.trigger.enabled,
      signingMode: contract.trigger.signingMode,
      replayWindowSec: contract.trigger.replayWindowSeconds,
    },
    contractDigest,
  };
}

function result(
  input: PaperclipGithubTransitionRoutineInput,
  spec: RoutineSpec,
  status: "planned" | "applied",
  routineDisposition: PaperclipGithubTransitionRoutineResult["routineDisposition"],
  triggerDisposition: PaperclipGithubTransitionRoutineResult["triggerDisposition"],
  infisicalSynced: boolean,
): PaperclipGithubTransitionRoutineResult {
  return {
    schemaVersion: 1,
    status,
    controller: input.controller,
    routineKey: spec.key,
    routineDisposition,
    triggerDisposition,
    initialStatus: "paused",
    trigger: {
      kind: "webhook",
      enabled: true,
      signingMode: "hmac_sha256",
      replayWindowSeconds: 300,
    },
    infisicalSynced,
    contractDigest: spec.contractDigest,
    exceptionDigest: digest(input.paperclipSecretStorageException),
  };
}

function coreMatches(
  routine: PaperclipRoutineDetail,
  input: PaperclipGithubTransitionRoutineInput,
  spec: RoutineSpec,
): boolean {
  return routine.companyId === input.company.id && routine.projectId === input.projectId &&
    routine.folderId == null && routine.goalId === null && routine.parentIssueId === null &&
    routine.title === spec.title && routine.description === spec.description &&
    routine.assigneeAgentId === input.controllerAgentId && routine.priority === "high" &&
    routine.status === "paused" && routine.concurrencyPolicy === "always_enqueue" &&
    routine.catchUpPolicy === "skip_missed" && routine.variables.length === 0;
}

type WebhookTrigger = PaperclipRoutineDetail["triggers"][number] & {
  readonly publicId: string;
  readonly lastRotatedAt: string;
};

function webhookTrigger(routine: PaperclipRoutineDetail, spec: RoutineSpec): WebhookTrigger | undefined {
  const trigger = routine.triggers[0];
  if (
    routine.triggers.length !== 1 || trigger === undefined || trigger.kind !== "webhook" ||
    trigger.label !== spec.trigger.label || trigger.enabled !== true || trigger.cronExpression !== null ||
    trigger.timezone !== null || trigger.signingMode !== "hmac_sha256" || trigger.replayWindowSec !== 300 ||
    typeof trigger.publicId !== "string" || !/^[A-Za-z0-9_-]{8,255}$/u.test(trigger.publicId) ||
    typeof trigger.lastRotatedAt !== "string" || !validIsoTimestamp(trigger.lastRotatedAt)
  ) return undefined;
  return trigger as WebhookTrigger;
}

function receiptMetadata(
  role: "webhook_url" | "webhook_secret",
  spec: RoutineSpec,
  trigger: Pick<WebhookTrigger, "id" | "publicId" | "lastRotatedAt">,
): readonly InfisicalSecretMetadata[] {
  return [
    { key: "flama_receipt_version", value: "1", isEncrypted: false },
    { key: "flama_secret_role", value: role, isEncrypted: false },
    { key: "flama_contract_digest", value: spec.contractDigest, isEncrypted: false },
    { key: "paperclip_trigger_id", value: trigger.id, isEncrypted: false },
    { key: "paperclip_public_id", value: trigger.publicId, isEncrypted: false },
    { key: "paperclip_last_rotated_at", value: trigger.lastRotatedAt, isEncrypted: false },
  ];
}

function sameMetadata(
  observed: readonly InfisicalSecretMetadata[] | null,
  expected: readonly InfisicalSecretMetadata[],
): boolean {
  if (observed === null || observed.length !== expected.length) return false;
  const normalize = (values: readonly InfisicalSecretMetadata[]) => [...values].sort((left, right) =>
    left.key.localeCompare(right.key)
  );
  return JSON.stringify(normalize(observed)) === JSON.stringify(normalize(expected));
}

function materialMatches(material: PaperclipWebhookSecretMaterial, trigger: WebhookTrigger): boolean {
  return material.trigger.id === trigger.id && material.trigger.publicId === trigger.publicId &&
    material.trigger.lastRotatedAt === trigger.lastRotatedAt;
}

function rotationDue(
  input: PaperclipGithubTransitionRoutineInput,
  trigger: WebhookTrigger,
  now: Date,
): boolean {
  const rotatedAt = Date.parse(trigger.lastRotatedAt);
  return rotatedAt + input.paperclipSecretStorageException.rotationDays * 86_400_000 <= now.getTime();
}

async function syncMaterial(
  input: PaperclipGithubTransitionRoutineInput,
  spec: RoutineSpec,
  material: PaperclipWebhookSecretMaterial,
  store: InfisicalRoutineSecretStore,
): Promise<void> {
  const urlMetadata = receiptMetadata("webhook_url", spec, material.trigger);
  const secretMetadata = receiptMetadata("webhook_secret", spec, material.trigger);
  try {
    await store.upsertSecret(input.infisical, webhookUrlSecretName, material.webhookUrl, urlMetadata);
    await store.upsertSecret(input.infisical, webhookSecretSecretName, material.webhookSecret, secretMetadata);
    const [observedUrl, observedSecret] = await Promise.all([
      store.readMetadata(input.infisical, webhookUrlSecretName),
      store.readMetadata(input.infisical, webhookSecretSecretName),
    ]);
    if (!sameMetadata(observedUrl, urlMetadata) || !sameMetadata(observedSecret, secretMetadata)) {
      throw new PaperclipGithubTransitionRoutineError("infisical_receipt_invalid");
    }
  } catch (error) {
    if (error instanceof PaperclipGithubTransitionRoutineError && error.code === "infisical_receipt_invalid") throw error;
    throw new PaperclipGithubTransitionRoutineError("infisical_sync_failed");
  }
}

export function planPaperclipGithubTransitionRoutine(
  input: PaperclipGithubTransitionRoutineInput,
  contract: PaperclipGithubTransitionRoutineContract,
  now = new Date(),
): PaperclipGithubTransitionRoutineResult {
  const spec = routineSpec(input, contract, now);
  return result(input, spec, "planned", "planned", "planned", false);
}

export async function applyPaperclipGithubTransitionRoutine(
  input: PaperclipGithubTransitionRoutineInput,
  contract: PaperclipGithubTransitionRoutineContract,
  client: PaperclipWebhookRoutinesClient,
  store: InfisicalRoutineSecretStore,
  now = new Date(),
): Promise<PaperclipGithubTransitionRoutineResult> {
  const spec = routineSpec(input, contract, now);
  const [company, agent, project, routines] = await Promise.all([
    client.getCompany(input.company.id),
    client.getAgent(input.controllerAgentId),
    client.getProject(input.projectId),
    client.listRoutines(input.company.id),
  ]);
  if (company.id !== input.company.id || company.name !== input.company.name || company.status !== "active") {
    throw new PaperclipGithubTransitionRoutineError("paperclip_company_mismatch");
  }
  if (agent.status === "pending_approval") {
    throw new PaperclipGithubTransitionRoutineError("paperclip_agent_approval_required");
  }
  if (
    agent.id !== input.controllerAgentId || agent.companyId !== input.company.id || agent.name !== input.controller ||
    agent.role !== "devops" || agent.adapterType !== "process" || agent.budgetMonthlyCents !== 0 || agent.status !== "paused"
  ) throw new PaperclipGithubTransitionRoutineError("paperclip_agent_mismatch");
  if (
    project.id !== input.projectId || project.companyId !== input.company.id || project.archivedAt != null ||
    !["backlog", "planned", "in_progress"].includes(project.status)
  ) throw new PaperclipGithubTransitionRoutineError("paperclip_project_mismatch");

  const matches = routines.filter((routine) => routine.title === spec.title);
  if (matches.length > 1) throw new PaperclipGithubTransitionRoutineError("paperclip_routine_drift");
  const existing = matches[0];
  let routineId: string;
  let routineDisposition: "created" | "reused";
  if (existing === undefined) {
    const { key: _key, trigger: _trigger, contractDigest: _contractDigest, ...createInput } = spec;
    const created = await client.createRoutine(input.company.id, createInput);
    routineId = created.id;
    routineDisposition = "created";
  } else {
    routineId = existing.id;
    routineDisposition = "reused";
  }

  let detail = await client.getRoutine(routineId);
  if (detail.id !== routineId || !coreMatches(detail, input, spec)) {
    throw new PaperclipGithubTransitionRoutineError("paperclip_routine_drift");
  }

  let triggerDisposition: "created" | "reused" | "rotated";
  if (detail.triggers.length === 0) {
    const material = await client.createWebhookTrigger(routineId, spec.trigger);
    detail = await client.getRoutine(routineId);
    const trigger = webhookTrigger(detail, spec);
    if (detail.id !== routineId || !coreMatches(detail, input, spec) || trigger === undefined ||
      !materialMatches(material, trigger)) {
      throw new PaperclipGithubTransitionRoutineError("paperclip_routine_drift");
    }
    await syncMaterial(input, spec, material, store);
    triggerDisposition = "created";
  } else {
    const trigger = webhookTrigger(detail, spec);
    if (trigger === undefined) throw new PaperclipGithubTransitionRoutineError("paperclip_routine_drift");
    const expectedUrlMetadata = receiptMetadata("webhook_url", spec, trigger);
    const expectedSecretMetadata = receiptMetadata("webhook_secret", spec, trigger);
    const [observedUrl, observedSecret] = await Promise.all([
      store.readMetadata(input.infisical, webhookUrlSecretName),
      store.readMetadata(input.infisical, webhookSecretSecretName),
    ]);
    if (
      sameMetadata(observedUrl, expectedUrlMetadata) && sameMetadata(observedSecret, expectedSecretMetadata) &&
      !rotationDue(input, trigger, now)
    ) {
      triggerDisposition = "reused";
    } else {
      const material = await client.rotateWebhookTriggerSecret(trigger.id);
      detail = await client.getRoutine(routineId);
      const rotated = webhookTrigger(detail, spec);
      if (detail.id !== routineId || !coreMatches(detail, input, spec) || rotated === undefined ||
        !materialMatches(material, rotated) ||
        Date.parse(rotated.lastRotatedAt) <= Date.parse(trigger.lastRotatedAt)) {
        throw new PaperclipGithubTransitionRoutineError("paperclip_routine_drift");
      }
      await syncMaterial(input, spec, material, store);
      triggerDisposition = "rotated";
    }
  }
  return result(input, spec, "applied", routineDisposition, triggerDisposition, true);
}

type Environment = Readonly<Record<string, string | undefined>>;
type FetchImplementation = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class InfisicalRestRoutineSecretStore implements InfisicalRoutineSecretStore {
  readonly #apiBase: string;
  readonly #token: string;

  constructor(environment: Environment, private readonly fetchImplementation: FetchImplementation = fetch) {
    const rawBase = environment["INFISICAL_API_URL"];
    const token = environment["INFISICAL_TOKEN"];
    if (rawBase === undefined || token === undefined || token.length < 20 || token.length > 4_096 || /[\r\n]/u.test(token)) {
      throw new PaperclipGithubTransitionRoutineError("infisical_identity_unavailable");
    }
    let url: URL;
    try {
      url = new URL(rawBase);
    } catch {
      throw new PaperclipGithubTransitionRoutineError("infisical_identity_unavailable");
    }
    const localHttp = url.protocol === "http:" && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !localHttp) || url.username || url.password || url.search || url.hash) {
      throw new PaperclipGithubTransitionRoutineError("infisical_identity_unavailable");
    }
    this.#apiBase = url.toString().replace(/\/+$/u, "");
    this.#token = token;
  }

  async #fetch(path: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImplementation(`${this.#apiBase}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.#token}`,
          Accept: "application/json",
          ...init.headers,
        },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new PaperclipGithubTransitionRoutineError("infisical_api_rejected");
    }
  }

  async #boundedJson(response: Response): Promise<unknown> {
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && (!/^[0-9]+$/u.test(contentLength) || Number(contentLength) > 2_097_152)) {
      await response.body?.cancel();
      throw new PaperclipGithubTransitionRoutineError("infisical_response_invalid");
    }
    let source: string;
    try {
      source = await response.text();
    } catch {
      throw new PaperclipGithubTransitionRoutineError("infisical_response_invalid");
    }
    if (Buffer.byteLength(source, "utf8") > 2_097_152) {
      throw new PaperclipGithubTransitionRoutineError("infisical_response_invalid");
    }
    try {
      return JSON.parse(source) as unknown;
    } catch {
      throw new PaperclipGithubTransitionRoutineError("infisical_response_invalid");
    }
  }

  async readMetadata(
    mapping: PaperclipGithubTransitionRoutineInput["infisical"],
    secretName: typeof webhookUrlSecretName | typeof webhookSecretSecretName,
  ): Promise<readonly InfisicalSecretMetadata[] | null> {
    const query = new URLSearchParams({
      projectId: mapping.projectId,
      environment: mapping.environment,
      secretPath: mapping.secretPath,
      type: "shared",
      viewSecretValue: "false",
      expandSecretReferences: "false",
    });
    const response = await this.#fetch(`/api/v4/secrets/${encodeURIComponent(secretName)}?${query.toString()}`, {
      method: "GET",
    });
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new PaperclipGithubTransitionRoutineError("infisical_api_rejected");
    }
    const value = await this.#boundedJson(response);
    if (!isRecord(value) || !isRecord(value["secret"])) {
      throw new PaperclipGithubTransitionRoutineError("infisical_response_invalid");
    }
    const secret = value["secret"];
    const rawMetadata = secret["secretMetadata"];
    if (
      secret["secretKey"] !== secretName ||
      (rawMetadata !== undefined && rawMetadata !== null && !Array.isArray(rawMetadata)) ||
      (typeof secret["secretValue"] === "string" && secret["secretValue"].length > 0 &&
        secret["secretValueHidden"] !== true)
    ) throw new PaperclipGithubTransitionRoutineError("infisical_response_invalid");
    const metadata = Array.isArray(rawMetadata) ? rawMetadata : [];
    return metadata.map((entry) => {
      if (!isRecord(entry) || typeof entry["key"] !== "string" || typeof entry["value"] !== "string" ||
        entry["isEncrypted"] !== false) {
        throw new PaperclipGithubTransitionRoutineError("infisical_response_invalid");
      }
      return { key: entry["key"], value: entry["value"], isEncrypted: false };
    });
  }

  async upsertSecret(
    mapping: PaperclipGithubTransitionRoutineInput["infisical"],
    secretName: typeof webhookUrlSecretName | typeof webhookSecretSecretName,
    value: string,
    metadata: readonly InfisicalSecretMetadata[],
  ): Promise<void> {
    const existing = await this.readMetadata(mapping, secretName);
    const response = await this.#fetch(`/api/v4/secrets/${encodeURIComponent(secretName)}`, {
      method: existing === null ? "POST" : "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: mapping.projectId,
        environment: mapping.environment,
        secretPath: mapping.secretPath,
        secretValue: value,
        secretComment: "Managed by flama-delivery-platform; verify using non-secret receipt metadata.",
        secretMetadata: metadata,
        skipMultilineEncoding: true,
        type: "shared",
      }),
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new PaperclipGithubTransitionRoutineError("infisical_api_rejected");
    }
    // Infisical write responses echo secret values. Never read or retain that body.
    await response.body?.cancel();
  }
}
