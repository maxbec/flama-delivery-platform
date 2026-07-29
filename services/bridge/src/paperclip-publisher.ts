import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { SecretValue } from "./config.js";
import { transitionKindForMinimizedEvent } from "./github-event.js";
import type { PaperclipPublisher, PaperclipTransitionMessage } from "./processor.js";

type CompanyName = "Private" | "// Navigaite" | "Edilio";
type ControllerName =
  | "maxbec-delivery-controller"
  | "navigaite-delivery-controller"
  | "edilio-delivery-controller";
type JsonRecord = Readonly<Record<string, unknown>>;
type FetchImplementation = (input: string | URL, init?: RequestInit) => Promise<Response>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const controllerByCompany: Readonly<Record<CompanyName, ControllerName>> = {
  Private: "maxbec-delivery-controller",
  "// Navigaite": "navigaite-delivery-controller",
  Edilio: "edilio-delivery-controller",
};
const allowedEdges = new Set([
  "flama-project-bootstrap-v1\u0000workflow_run.completed\u0000repository_prepared\u0000baseline_green",
  "flama-feature-fix-v1\u0000pull_request.opened\u0000preflight_passed\u0000pr_open",
  "flama-feature-fix-v1\u0000pull_request.reopened\u0000preflight_passed\u0000pr_open",
  "flama-feature-fix-v1\u0000pull_request.ready_for_review\u0000preflight_passed\u0000pr_open",
  "flama-feature-fix-v1\u0000pull_request.merged\u0000pr_open\u0000merged",
  "flama-release-deployment-v1\u0000release.published\u0000production_verification\u0000released",
  "flama-release-deployment-v1\u0000pull_request.opened\u0000released\u0000deployment_pr_open",
  "flama-release-deployment-v1\u0000pull_request.reopened\u0000released\u0000deployment_pr_open",
  "flama-release-deployment-v1\u0000pull_request.ready_for_review\u0000released\u0000deployment_pr_open",
  "flama-release-deployment-v1\u0000pull_request.merged\u0000awaiting_owner_approval\u0000deploying",
  "flama-release-deployment-v1\u0000deployment_status.success\u0000deploying\u0000verified",
]);

export type PaperclipPublicationErrorCode =
  | "authorization_missing"
  | "authorization_scope_mismatch"
  | "event_evidence_invalid"
  | "paperclip_identity_unavailable"
  | "paperclip_response_invalid"
  | "paperclip_scope_mismatch"
  | "paperclip_state_conflict"
  | "paperclip_unavailable";

export class PaperclipPublicationError extends Error {
  constructor(readonly code: PaperclipPublicationErrorCode) {
    super("Paperclip publication rejected");
    this.name = "PaperclipPublicationError";
  }
}

export interface AuthorizedTransition {
  readonly idempotencyKey: string;
  readonly repository: string;
  readonly company: CompanyName;
  readonly controllerName: ControllerName;
  readonly caseId: string;
  readonly pipelineId: string;
  readonly pipelineKey:
    | "flama-project-bootstrap-v1"
    | "flama-feature-fix-v1"
    | "flama-release-deployment-v1";
  readonly transitionKind: string;
  readonly fromStageKey: string;
  readonly toStageKey: string;
  readonly eventDigest: string;
  readonly evidenceDigest: string;
  readonly bindingDigest: string;
  readonly defaultBranch: string;
  readonly alreadyPublished: boolean;
}

export interface TransitionAuthorizationStore {
  resolve(
    message: PaperclipTransitionMessage,
    eventDigest: string,
    now: Date,
  ): Promise<AuthorizedTransition | undefined>;
  markPublished(idempotencyKey: string, now: Date): Promise<void>;
}

interface AuthorizationRow {
  readonly idempotency_key: string;
  readonly repository_name: string;
  readonly company: CompanyName;
  readonly controller_name: ControllerName;
  readonly case_id: string;
  readonly pipeline_id: string;
  readonly pipeline_key: AuthorizedTransition["pipelineKey"];
  readonly transition_kind: string;
  readonly from_stage_key: string;
  readonly to_stage_key: string;
  readonly event_digest: string;
  readonly evidence_digest: string;
  readonly binding_digest: string;
  readonly default_branch: string;
  readonly published_at: Date | null;
}

export class PostgresTransitionAuthorizationStore implements TransitionAuthorizationStore {
  constructor(private readonly pool: Pool) {}

  async resolve(
    message: PaperclipTransitionMessage,
    eventDigest: string,
    now: Date,
  ): Promise<AuthorizedTransition | undefined> {
    const repository = message.payload["repository"];
    if (typeof repository !== "string") return undefined;
    const result = await this.pool.query<AuthorizationRow>(
      `SELECT eta.idempotency_key, eta.repository_name,
              eta.company, eta.controller_name, eta.case_id::text,
              eta.pipeline_id::text, eta.pipeline_key,
              eta.transition_kind, eta.from_stage_key,
              eta.to_stage_key, eta.event_digest,
              eta.evidence_digest, eta.binding_digest,
              binding.default_branch, eta.published_at
       FROM flama_delivery.external_transition_authorization AS eta
       INNER JOIN flama_delivery.repository_binding AS binding
         ON binding.repository_name = eta.repository_name
       WHERE eta.idempotency_key = $1
         AND eta.repository_name = $2
         AND eta.company = $3
         AND eta.transition_kind = $4
         AND eta.event_digest = $5
         AND eta.revoked_at IS NULL
         AND eta.expires_at > $6
         AND binding.company = eta.company
         AND binding.binding_digest = eta.binding_digest
         AND binding.active
         AND NOT binding.is_fork
         AND NOT binding.is_archived`,
      [
        message.idempotencyKey,
        repository,
        message.company,
        message.transitionKind,
        eventDigest,
        now,
      ],
    );
    const row = result.rows[0];
    if (row === undefined || result.rows.length !== 1) return undefined;
    return {
      idempotencyKey: row.idempotency_key,
      repository: row.repository_name,
      company: row.company,
      controllerName: row.controller_name,
      caseId: row.case_id,
      pipelineId: row.pipeline_id,
      pipelineKey: row.pipeline_key,
      transitionKind: row.transition_kind,
      fromStageKey: row.from_stage_key,
      toStageKey: row.to_stage_key,
      eventDigest: row.event_digest,
      evidenceDigest: row.evidence_digest,
      bindingDigest: row.binding_digest,
      defaultBranch: row.default_branch,
      alreadyPublished: row.published_at !== null,
    };
  }

  async markPublished(idempotencyKey: string, now: Date): Promise<void> {
    const result = await this.pool.query(
      `UPDATE flama_delivery.external_transition_authorization
       SET published_at = COALESCE(published_at, $2)
       WHERE idempotency_key = $1`,
      [idempotencyKey, now],
    );
    if (result.rowCount !== 1) throw new PaperclipPublicationError("authorization_scope_mismatch");
  }
}

export interface PaperclipCaseDetail {
  readonly caseId: string;
  readonly companyId: string;
  readonly pipelineId: string;
  readonly pipelineKey: string;
  readonly stageKey: string;
  readonly version: number;
  readonly terminalKind: string | null;
}

export interface PaperclipTransitionEvent {
  readonly type: string;
  readonly fromStageKey: string | null;
  readonly toStageKey: string | null;
  readonly reason: string | null;
}

export interface PaperclipTransitionApi {
  getCase(caseId: string): Promise<PaperclipCaseDetail>;
  listCaseEvents(caseId: string): Promise<readonly PaperclipTransitionEvent[]>;
  transitionCase(caseId: string, input: {
    readonly toStageKey: string;
    readonly expectedVersion: number;
    readonly reason: string;
  }): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

export function minimizedEventDigest(value: JsonRecord): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex")}`;
}

function reasonFor(idempotencyKey: string): string {
  return `flama-external:sha256:${createHash("sha256").update(idempotencyKey).digest("hex")}`;
}

function recordAt(value: JsonRecord, key: string): JsonRecord | undefined {
  const nested = value[key];
  return isRecord(nested) ? nested : undefined;
}

function validEventEvidence(message: PaperclipTransitionMessage, authorization: AuthorizedTransition): boolean {
  const payload = message.payload;
  const eventName = payload["eventName"];
  const repository = payload["repository"];
  if (
    typeof eventName !== "string" || repository !== authorization.repository ||
    transitionKindForMinimizedEvent(payload, eventName, authorization.repository) !== message.transitionKind
  ) return false;

  if (authorization.pipelineKey === "flama-project-bootstrap-v1") {
    const run = recordAt(payload, "workflowRun");
    return message.transitionKind === "workflow_run.completed" &&
      run?.["status"] === "completed" && run["conclusion"] === "success";
  }

  if (message.transitionKind.startsWith("pull_request.")) {
    const pullRequest = recordAt(payload, "pullRequest");
    if (pullRequest?.["baseRef"] !== authorization.defaultBranch) return false;
    const headRef = pullRequest["headRef"];
    if (typeof headRef !== "string") return false;
    if (authorization.pipelineKey === "flama-feature-fix-v1" && headRef.startsWith("deploy/")) return false;
    if (authorization.pipelineKey === "flama-release-deployment-v1" && !headRef.startsWith("deploy/")) return false;
    if (message.transitionKind === "pull_request.merged") {
      return payload["action"] === "closed" && pullRequest["state"] === "closed" &&
        pullRequest["merged"] === true && typeof pullRequest["mergeSha"] === "string";
    }
    return payload["action"] === message.transitionKind.slice("pull_request.".length) &&
      pullRequest["state"] === "open" && pullRequest["merged"] === false && pullRequest["mergeSha"] === null;
  }

  if (message.transitionKind === "release.published") {
    const release = recordAt(payload, "release");
    return payload["action"] === "published" && release?.["draft"] === false && release["prerelease"] === false;
  }

  if (message.transitionKind === "deployment_status.success") {
    const status = recordAt(payload, "deploymentStatus");
    return payload["action"] === "created" && status?.["state"] === "success" &&
      typeof status["environment"] === "string" && status["environment"].toLowerCase() === "production";
  }
  return false;
}

function validAuthorization(message: PaperclipTransitionMessage, authorization: AuthorizedTransition, digest: string): boolean {
  const allowedEdge = [
    authorization.pipelineKey,
    authorization.transitionKind,
    authorization.fromStageKey,
    authorization.toStageKey,
  ].join("\u0000");
  return allowedEdges.has(allowedEdge) && authorization.idempotencyKey === message.idempotencyKey &&
    authorization.company === message.company &&
    authorization.controllerName === controllerByCompany[message.company] &&
    authorization.transitionKind === message.transitionKind &&
    authorization.eventDigest === digest && digestPattern.test(authorization.evidenceDigest) &&
    digestPattern.test(authorization.bindingDigest) && uuidPattern.test(authorization.caseId) &&
    uuidPattern.test(authorization.pipelineId);
}

function hasTransitionEvent(
  events: readonly PaperclipTransitionEvent[],
  authorization: AuthorizedTransition,
  reason: string,
): boolean {
  return events.some((event) => event.type === "transitioned" &&
    event.fromStageKey === authorization.fromStageKey && event.toStageKey === authorization.toStageKey &&
    event.reason === reason);
}

export class AuthorizedPaperclipPublisher implements PaperclipPublisher {
  constructor(
    private readonly company: CompanyName,
    private readonly companyId: string,
    private readonly authorizations: TransitionAuthorizationStore,
    private readonly api: PaperclipTransitionApi,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!uuidPattern.test(companyId)) throw new PaperclipPublicationError("paperclip_identity_unavailable");
  }

  async publish(message: PaperclipTransitionMessage): Promise<void> {
    const expectedKey = `github:${message.deliveryId}:${message.transitionKind}`;
    if (message.company !== this.company || message.idempotencyKey !== expectedKey) {
      throw new PaperclipPublicationError("authorization_scope_mismatch");
    }
    const eventDigest = minimizedEventDigest(message.payload);
    const authorization = await this.authorizations.resolve(message, eventDigest, this.now());
    if (authorization === undefined) throw new PaperclipPublicationError("authorization_missing");
    if (!validAuthorization(message, authorization, eventDigest)) {
      throw new PaperclipPublicationError("authorization_scope_mismatch");
    }
    if (!validEventEvidence(message, authorization)) {
      throw new PaperclipPublicationError("event_evidence_invalid");
    }
    if (authorization.alreadyPublished) return;

    const reason = reasonFor(message.idempotencyKey);
    const detail = await this.api.getCase(authorization.caseId);
    if (
      detail.caseId !== authorization.caseId || detail.companyId !== this.companyId ||
      detail.pipelineId !== authorization.pipelineId || detail.pipelineKey !== authorization.pipelineKey ||
      detail.terminalKind !== null
    ) throw new PaperclipPublicationError("paperclip_scope_mismatch");

    if (detail.stageKey !== authorization.fromStageKey) {
      const events = await this.api.listCaseEvents(authorization.caseId);
      if (!hasTransitionEvent(events, authorization, reason)) {
        throw new PaperclipPublicationError("paperclip_state_conflict");
      }
      await this.authorizations.markPublished(message.idempotencyKey, this.now());
      return;
    }

    await this.api.transitionCase(authorization.caseId, {
      toStageKey: authorization.toStageKey,
      expectedVersion: detail.version,
      reason,
    });
    const transitioned = await this.api.getCase(authorization.caseId);
    if (
      transitioned.caseId !== authorization.caseId || transitioned.companyId !== this.companyId ||
      transitioned.pipelineId !== authorization.pipelineId || transitioned.pipelineKey !== authorization.pipelineKey ||
      transitioned.version <= detail.version
    ) throw new PaperclipPublicationError("paperclip_scope_mismatch");
    if (transitioned.stageKey !== authorization.toStageKey) {
      const events = await this.api.listCaseEvents(authorization.caseId);
      if (!hasTransitionEvent(events, authorization, reason)) {
        throw new PaperclipPublicationError("paperclip_state_conflict");
      }
    }
    await this.authorizations.markPublished(message.idempotencyKey, this.now());
  }
}

interface PaperclipPublisherConfig {
  readonly apiBase: string;
  readonly apiKey: SecretValue;
}

export function parsePaperclipPublisherConfig(environment: Readonly<Record<string, string | undefined>>): PaperclipPublisherConfig {
  const rawBase = environment["PAPERCLIP_API_URL"];
  const rawKey = environment["PAPERCLIP_API_KEY"];
  if (rawBase === undefined || rawKey === undefined || rawKey.length < 20 || rawKey.length > 4_096 || /[\r\n]/u.test(rawKey)) {
    throw new PaperclipPublicationError("paperclip_identity_unavailable");
  }
  let url: URL;
  try {
    url = new URL(rawBase);
  } catch {
    throw new PaperclipPublicationError("paperclip_identity_unavailable");
  }
  const localHttp = url.protocol === "http:" && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !localHttp) || url.username || url.password || url.search || url.hash) {
    throw new PaperclipPublicationError("paperclip_identity_unavailable");
  }
  return { apiBase: url.toString().replace(/\/+$/u, ""), apiKey: new SecretValue(rawKey) };
}

async function boundedJson(response: Response): Promise<unknown> {
  const maximumBytes = 2 * 1_024 * 1_024;
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maximumBytes) {
    throw new PaperclipPublicationError("paperclip_response_invalid");
  }
  if (response.body === null) throw new PaperclipPublicationError("paperclip_response_invalid");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new PaperclipPublicationError("paperclip_response_invalid");
    }
    chunks.push(value);
  }
  const body = Buffer.concat(chunks, total).toString("utf8");
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new PaperclipPublicationError("paperclip_response_invalid");
  }
}

export class PaperclipRestTransitionApi implements PaperclipTransitionApi {
  readonly #apiBase: string;
  readonly #apiKey: SecretValue;

  constructor(
    environment: Readonly<Record<string, string | undefined>>,
    private readonly fetchImplementation: FetchImplementation = fetch,
  ) {
    const config = parsePaperclipPublisherConfig(environment);
    this.#apiBase = config.apiBase;
    this.#apiKey = config.apiKey;
  }

  async #request(path: string, init: RequestInit = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.#apiBase}${path}`, {
        ...init,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.#apiKey.reveal()}`,
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new PaperclipPublicationError("paperclip_unavailable");
    }
    if (!response.ok) throw new PaperclipPublicationError("paperclip_unavailable");
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      throw new PaperclipPublicationError("paperclip_response_invalid");
    }
    return boundedJson(response);
  }

  async getCase(caseId: string): Promise<PaperclipCaseDetail> {
    if (!uuidPattern.test(caseId)) throw new PaperclipPublicationError("paperclip_scope_mismatch");
    const value = await this.#request(`/api/cases/${encodeURIComponent(caseId)}`);
    if (!isRecord(value) || !isRecord(value["case"]) || !isRecord(value["stage"]) || !isRecord(value["pipeline"])) {
      throw new PaperclipPublicationError("paperclip_response_invalid");
    }
    const caseValue = value["case"];
    const stage = value["stage"];
    const pipeline = value["pipeline"];
    const detail: PaperclipCaseDetail = {
      caseId: typeof caseValue["id"] === "string" ? caseValue["id"] : "",
      companyId: typeof caseValue["companyId"] === "string" ? caseValue["companyId"] : "",
      pipelineId: typeof caseValue["pipelineId"] === "string" ? caseValue["pipelineId"] : "",
      pipelineKey: typeof pipeline["key"] === "string" ? pipeline["key"] : "",
      stageKey: typeof stage["key"] === "string" ? stage["key"] : "",
      version: typeof caseValue["version"] === "number" ? caseValue["version"] : 0,
      terminalKind: caseValue["terminalKind"] === null || typeof caseValue["terminalKind"] === "string"
        ? caseValue["terminalKind"]
        : "invalid",
    };
    if (
      !uuidPattern.test(detail.caseId) || !uuidPattern.test(detail.companyId) ||
      !uuidPattern.test(detail.pipelineId) || pipeline["id"] !== detail.pipelineId ||
      pipeline["companyId"] !== detail.companyId ||
      !/^[a-z][a-z0-9-]{0,119}$/u.test(detail.pipelineKey) ||
      !/^[a-z][a-z0-9_]{0,119}$/u.test(detail.stageKey) ||
      !Number.isSafeInteger(detail.version) || detail.version < 1
    ) throw new PaperclipPublicationError("paperclip_response_invalid");
    return detail;
  }

  async listCaseEvents(caseId: string): Promise<readonly PaperclipTransitionEvent[]> {
    if (!uuidPattern.test(caseId)) throw new PaperclipPublicationError("paperclip_scope_mismatch");
    const events: PaperclipTransitionEvent[] = [];
    for (let offset = 0; offset < 10_000; offset += 100) {
      const value = await this.#request(`/api/cases/${encodeURIComponent(caseId)}/events?limit=100&offset=${offset}`);
      if (!isRecord(value) || !Array.isArray(value["items"]) || !isRecord(value["pagination"])) {
        throw new PaperclipPublicationError("paperclip_response_invalid");
      }
      for (const item of value["items"] as unknown[]) {
        if (!isRecord(item)) throw new PaperclipPublicationError("paperclip_response_invalid");
        const payload = isRecord(item["payload"]) ? item["payload"] : {};
        const fromStage = isRecord(item["fromStage"]) ? item["fromStage"] : undefined;
        const toStage = isRecord(item["toStage"]) ? item["toStage"] : undefined;
        events.push({
          type: typeof item["type"] === "string" ? item["type"] : "",
          fromStageKey: typeof fromStage?.["key"] === "string" ? fromStage["key"] : null,
          toStageKey: typeof toStage?.["key"] === "string" ? toStage["key"] : null,
          reason: typeof payload["reason"] === "string" ? payload["reason"] : null,
        });
      }
      const pagination = value["pagination"];
      if (pagination["hasMore"] === false && pagination["nextOffset"] === null) return events;
      if (pagination["hasMore"] !== true || pagination["nextOffset"] !== offset + 100) {
        throw new PaperclipPublicationError("paperclip_response_invalid");
      }
    }
    throw new PaperclipPublicationError("paperclip_response_invalid");
  }

  async transitionCase(caseId: string, input: {
    readonly toStageKey: string;
    readonly expectedVersion: number;
    readonly reason: string;
  }): Promise<void> {
    if (
      !uuidPattern.test(caseId) || !/^[a-z][a-z0-9_]{0,119}$/u.test(input.toStageKey) ||
      !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1 ||
      !/^flama-external:sha256:[0-9a-f]{64}$/u.test(input.reason)
    ) throw new PaperclipPublicationError("paperclip_scope_mismatch");
    const value = await this.#request(`/api/cases/${encodeURIComponent(caseId)}/transition`, {
      method: "POST",
      body: JSON.stringify(input),
    });
    if (
      !isRecord(value) || !isRecord(value["case"]) || value["case"]["id"] !== caseId ||
      value["case"]["version"] !== input.expectedVersion + 1
    ) {
      throw new PaperclipPublicationError("paperclip_response_invalid");
    }
  }
}
