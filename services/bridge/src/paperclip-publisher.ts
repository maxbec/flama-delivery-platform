import { createHash, createHmac } from "node:crypto";
import type { Pool } from "pg";
import { SecretValue } from "./config.js";
import { transitionKindForMinimizedEvent } from "./github-event.js";
import type { PaperclipPublisher, PaperclipTransitionMessage } from "./processor.js";

export type CompanyName = "Private" | "// Navigaite" | "Edilio";
export type ControllerName =
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
  | "paperclip_unavailable"
  | "routine_identity_unavailable"
  | "routine_response_invalid"
  | "routine_unavailable";

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

export interface PaperclipRoutineWebhookApi {
  fire(message: PaperclipTransitionMessage): Promise<void>;
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

function recordAt(value: JsonRecord, key: string): JsonRecord | undefined {
  const nested = value[key];
  return isRecord(nested) ? nested : undefined;
}

export function validEventEvidence(message: PaperclipTransitionMessage, authorization: AuthorizedTransition): boolean {
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

export function validAuthorization(
  message: PaperclipTransitionMessage,
  authorization: AuthorizedTransition,
  digest: string,
): boolean {
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

export class AuthorizedRoutineWebhookPublisher implements PaperclipPublisher {
  constructor(
    private readonly company: CompanyName,
    private readonly authorizations: TransitionAuthorizationStore,
    private readonly webhook: PaperclipRoutineWebhookApi,
    private readonly now: () => Date = () => new Date(),
  ) {}

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
    await this.webhook.fire(message);
  }
}

interface PaperclipRoutineWebhookConfig {
  readonly url: string;
  readonly secret: SecretValue;
}

export function parsePaperclipRoutineWebhookConfig(
  environment: Readonly<Record<string, string | undefined>>,
): PaperclipRoutineWebhookConfig {
  const rawUrl = environment["PAPERCLIP_ROUTINE_WEBHOOK_URL"];
  const rawSecret = environment["PAPERCLIP_ROUTINE_WEBHOOK_SECRET"];
  if (
    rawUrl === undefined || rawSecret === undefined || rawSecret.length < 32 || rawSecret.length > 4_096 ||
    /[\r\n]/u.test(rawSecret)
  ) throw new PaperclipPublicationError("routine_identity_unavailable");
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new PaperclipPublicationError("routine_identity_unavailable");
  }
  const localHttp = url.protocol === "http:" && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !localHttp) || url.username || url.password || url.search || url.hash ||
    !/^\/api\/routine-triggers\/public\/[A-Za-z0-9_-]{8,255}\/fire$/u.test(url.pathname)
  ) throw new PaperclipPublicationError("routine_identity_unavailable");
  return { url: url.toString(), secret: new SecretValue(rawSecret) };
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

export class PaperclipSignedRoutineWebhookApi implements PaperclipRoutineWebhookApi {
  readonly #url: string;
  readonly #secret: SecretValue;

  constructor(
    environment: Readonly<Record<string, string | undefined>>,
    private readonly fetchImplementation: FetchImplementation = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {
    const config = parsePaperclipRoutineWebhookConfig(environment);
    this.#url = config.url;
    this.#secret = config.secret;
  }

  async fire(message: PaperclipTransitionMessage): Promise<void> {
    const body = JSON.stringify({ schemaVersion: 1, message });
    const timestamp = String(this.now().getTime());
    const hmac = createHmac("sha256", this.#secret.reveal())
      .update(`${timestamp}.`)
      .update(body)
      .digest("hex");
    let response: Response;
    try {
      response = await this.fetchImplementation(this.#url, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "idempotency-key": message.idempotencyKey,
          "x-paperclip-signature": `sha256=${hmac}`,
          "x-paperclip-timestamp": timestamp,
        },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new PaperclipPublicationError("routine_unavailable");
    }
    if (response.status !== 202) {
      await response.body?.cancel();
      throw new PaperclipPublicationError("routine_unavailable");
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      await response.body?.cancel();
      throw new PaperclipPublicationError("routine_response_invalid");
    }
    const value = await boundedJson(response);
    if (
      !isRecord(value) || value["source"] !== "webhook" || value["idempotencyKey"] !== message.idempotencyKey ||
      !["issue_created", "completed"].includes(String(value["status"])) ||
      typeof value["linkedIssueId"] !== "string" || !uuidPattern.test(value["linkedIssueId"])
    ) throw new PaperclipPublicationError("routine_response_invalid");
    const expectedPayload = { schemaVersion: 1, message };
    if (JSON.stringify(stableValue(value["triggerPayload"])) !== JSON.stringify(stableValue(expectedPayload))) {
      throw new PaperclipPublicationError("routine_response_invalid");
    }
  }
}
