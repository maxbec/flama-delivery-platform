import { createHash } from "node:crypto";
import { Pool, type PoolClient } from "pg";

const companyControllers = {
  Private: "maxbec-delivery-controller",
  "// Navigaite": "navigaite-delivery-controller",
  Edilio: "edilio-delivery-controller",
} as const;

type CompanyName = keyof typeof companyControllers;
type ControllerName = typeof companyControllers[CompanyName];
type Disposition = "planned" | "created" | "reused";
type Environment = Readonly<Record<string, string | undefined>>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const deliveryPattern = /^[A-Za-z0-9._:-]{1,128}$/u;
const stagePattern = /^[a-z][a-z0-9_]{0,119}$/u;
const maximumAuthorizationMilliseconds = 60 * 60 * 1_000;
const maximumClockSkewMilliseconds = 5 * 60 * 1_000;
const maximumAuthorizationAgeMilliseconds = 15 * 60 * 1_000;

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

export interface PaperclipTransitionAuthorizationInput {
  readonly schemaVersion: 1;
  readonly company: CompanyName;
  readonly controller: ControllerName;
  readonly deliveryId: string;
  readonly transitionKind: string;
  readonly bindingDigest: string;
  readonly evidenceDigest: string;
  readonly case: {
    readonly id: string;
    readonly pipelineId: string;
    readonly pipelineKey:
      | "flama-project-bootstrap-v1"
      | "flama-feature-fix-v1"
      | "flama-release-deployment-v1";
    readonly fromStageKey: string;
    readonly toStageKey: string;
  };
  readonly authorizedAt: string;
  readonly expiresAt: string;
  readonly mutationAllowed: true;
}

export interface PaperclipTransitionAuthorizationResult {
  readonly schemaVersion: 1;
  readonly status: "planned" | "applied";
  readonly disposition: Disposition;
  readonly authorizationDigest: string;
}

export type PaperclipTransitionAuthorizationErrorCode =
  | "authorization_drift"
  | "authorization_event_unavailable"
  | "authorization_persistence_failed"
  | "authorization_scope_invalid"
  | "paperclip_identity_unavailable";

export class PaperclipTransitionAuthorizationError extends Error {
  constructor(readonly code: PaperclipTransitionAuthorizationErrorCode) {
    super("Paperclip transition authorization rejected");
    this.name = "PaperclipTransitionAuthorizationError";
  }
}

interface AuthorizationRecord {
  readonly idempotencyKey: string;
  readonly repositoryName: string;
  readonly company: CompanyName;
  readonly controllerName: ControllerName;
  readonly caseId: string;
  readonly pipelineId: string;
  readonly pipelineKey: PaperclipTransitionAuthorizationInput["case"]["pipelineKey"];
  readonly transitionKind: string;
  readonly fromStageKey: string;
  readonly toStageKey: string;
  readonly eventDigest: string;
  readonly evidenceDigest: string;
  readonly bindingDigest: string;
  readonly authorizedAt: string;
  readonly expiresAt: string;
}

export interface TransitionAuthorizationWriter {
  write(input: PaperclipTransitionAuthorizationInput): Promise<{
    readonly disposition: "created" | "reused";
    readonly record: AuthorizationRecord;
  }>;
}

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

function authorizationEdge(input: PaperclipTransitionAuthorizationInput): string {
  return [input.case.pipelineKey, input.transitionKind, input.case.fromStageKey, input.case.toStageKey].join("\u0000");
}

function validateInput(input: PaperclipTransitionAuthorizationInput, now: Date): void {
  const authorizedAt = new Date(input.authorizedAt);
  const expiresAt = new Date(input.expiresAt);
  if (
    input.schemaVersion !== 1 || input.mutationAllowed !== true ||
    companyControllers[input.company] !== input.controller || !deliveryPattern.test(input.deliveryId) ||
    !/^[a-z_]+\.[a-z_]+$/u.test(input.transitionKind) || !digestPattern.test(input.bindingDigest) ||
    !digestPattern.test(input.evidenceDigest) || !uuidPattern.test(input.case.id) ||
    !uuidPattern.test(input.case.pipelineId) || !stagePattern.test(input.case.fromStageKey) ||
    !stagePattern.test(input.case.toStageKey) || !allowedEdges.has(authorizationEdge(input)) ||
    !Number.isFinite(authorizedAt.getTime()) || authorizedAt.toISOString() !== input.authorizedAt ||
    !Number.isFinite(expiresAt.getTime()) || expiresAt.toISOString() !== input.expiresAt ||
    authorizedAt.getTime() > now.getTime() + maximumClockSkewMilliseconds ||
    authorizedAt.getTime() < now.getTime() - maximumAuthorizationAgeMilliseconds ||
    expiresAt.getTime() <= now.getTime() ||
    expiresAt.getTime() <= authorizedAt.getTime() ||
    expiresAt.getTime() - authorizedAt.getTime() > maximumAuthorizationMilliseconds
  ) throw new PaperclipTransitionAuthorizationError("authorization_scope_invalid");
}

function result(
  status: "planned" | "applied",
  disposition: Disposition,
  value: unknown,
): PaperclipTransitionAuthorizationResult {
  return { schemaVersion: 1, status, disposition, authorizationDigest: digest(value) };
}

export function planPaperclipTransitionAuthorization(
  input: PaperclipTransitionAuthorizationInput,
  now = new Date(),
): PaperclipTransitionAuthorizationResult {
  validateInput(input, now);
  return result("planned", "planned", input);
}

export async function applyPaperclipTransitionAuthorization(
  input: PaperclipTransitionAuthorizationInput,
  writer: TransitionAuthorizationWriter,
  now = new Date(),
): Promise<PaperclipTransitionAuthorizationResult> {
  validateInput(input, now);
  const written = await writer.write(input);
  return result("applied", written.disposition, written.record);
}

interface EventRow {
  readonly repository_name: string;
  readonly company: CompanyName;
  readonly transition_kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly binding_digest: string;
}

interface ExistingRow {
  readonly idempotency_key: string;
  readonly repository_name: string;
  readonly company: CompanyName;
  readonly controller_name: ControllerName;
  readonly case_id: string;
  readonly pipeline_id: string;
  readonly pipeline_key: AuthorizationRecord["pipelineKey"];
  readonly transition_kind: string;
  readonly from_stage_key: string;
  readonly to_stage_key: string;
  readonly event_digest: string;
  readonly evidence_digest: string;
  readonly binding_digest: string;
  readonly authorized_at: Date;
  readonly expires_at: Date;
  readonly revoked_at: Date | null;
}

function recordFromRow(row: ExistingRow): AuthorizationRecord {
  return {
    idempotencyKey: row.idempotency_key,
    repositoryName: row.repository_name,
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
    authorizedAt: row.authorized_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  };
}

function sameRecord(left: AuthorizationRecord, right: AuthorizationRecord): boolean {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

async function writeInTransaction(
  client: PoolClient,
  input: PaperclipTransitionAuthorizationInput,
): Promise<{ readonly disposition: "created" | "reused"; readonly record: AuthorizationRecord }> {
  const eventResult = await client.query<EventRow>(
    `SELECT inbox.repository_name, outbox.company, outbox.transition_kind, outbox.payload,
            binding.binding_digest
     FROM flama_delivery.transition_outbox AS outbox
     INNER JOIN flama_delivery.webhook_inbox AS inbox ON inbox.delivery_id = outbox.delivery_id
     INNER JOIN flama_delivery.repository_binding AS binding
       ON binding.repository_name = inbox.repository_name
     WHERE outbox.delivery_id = $1
       AND outbox.transition_kind = $2
       AND outbox.company = $3
       AND inbox.status = 'completed'
       AND outbox.status IN ('pending', 'processing', 'retry')
       AND binding.company = outbox.company
       AND binding.binding_digest = $4
       AND binding.active
       AND NOT binding.is_fork
       AND NOT binding.is_archived
     FOR UPDATE OF outbox, binding`,
    [input.deliveryId, input.transitionKind, input.company, input.bindingDigest],
  );
  const event = eventResult.rows[0];
  if (event === undefined || eventResult.rows.length !== 1) {
    throw new PaperclipTransitionAuthorizationError("authorization_event_unavailable");
  }
  const expected: AuthorizationRecord = {
    idempotencyKey: `github:${input.deliveryId}:${input.transitionKind}`,
    repositoryName: event.repository_name,
    company: input.company,
    controllerName: input.controller,
    caseId: input.case.id,
    pipelineId: input.case.pipelineId,
    pipelineKey: input.case.pipelineKey,
    transitionKind: input.transitionKind,
    fromStageKey: input.case.fromStageKey,
    toStageKey: input.case.toStageKey,
    eventDigest: digest(event.payload),
    evidenceDigest: input.evidenceDigest,
    bindingDigest: event.binding_digest,
    authorizedAt: input.authorizedAt,
    expiresAt: input.expiresAt,
  };
  const inserted = await client.query(
    `INSERT INTO flama_delivery.external_transition_authorization
      (idempotency_key, repository_name, company, controller_name, case_id, pipeline_id,
       pipeline_key, transition_kind, from_stage_key, to_stage_key, event_digest,
       evidence_digest, binding_digest, authorized_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [expected.idempotencyKey, expected.repositoryName, expected.company, expected.controllerName,
      expected.caseId, expected.pipelineId, expected.pipelineKey, expected.transitionKind,
      expected.fromStageKey, expected.toStageKey, expected.eventDigest, expected.evidenceDigest,
      expected.bindingDigest, expected.authorizedAt, expected.expiresAt],
  );
  if (inserted.rowCount === 1) return { disposition: "created", record: expected };
  const existingResult = await client.query<ExistingRow>(
    `SELECT idempotency_key, repository_name, company, controller_name, case_id::text,
            pipeline_id::text, pipeline_key, transition_kind, from_stage_key, to_stage_key,
            event_digest, evidence_digest, binding_digest, authorized_at, expires_at, revoked_at
     FROM flama_delivery.external_transition_authorization
     WHERE idempotency_key = $1
     FOR UPDATE`,
    [expected.idempotencyKey],
  );
  const existing = existingResult.rows[0];
  if (existing === undefined || existingResult.rows.length !== 1 || existing.revoked_at !== null) {
    throw new PaperclipTransitionAuthorizationError("authorization_drift");
  }
  const observed = recordFromRow(existing);
  if (!sameRecord(observed, expected)) throw new PaperclipTransitionAuthorizationError("authorization_drift");
  return { disposition: "reused", record: observed };
}

export class PostgresTransitionAuthorizationWriter implements TransitionAuthorizationWriter {
  readonly #pool: Pool;

  constructor(environment: Environment) {
    const source = environment["DATABASE_URL"];
    if (source === undefined || source.length > 4_096 || /[\r\n]/u.test(source)) {
      throw new PaperclipTransitionAuthorizationError("paperclip_identity_unavailable");
    }
    try {
      const url = new URL(source);
      if (!(url.protocol === "postgres:" || url.protocol === "postgresql:") || url.hostname.length === 0) throw new Error("invalid");
    } catch {
      throw new PaperclipTransitionAuthorizationError("paperclip_identity_unavailable");
    }
    this.#pool = new Pool({ connectionString: source, max: 1, application_name: "flama-transition-authorizer" });
  }

  async close(): Promise<void> { await this.#pool.end(); }

  async write(input: PaperclipTransitionAuthorizationInput): ReturnType<TransitionAuthorizationWriter["write"]> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const written = await writeInTransaction(client, input);
      await client.query("COMMIT");
      return written;
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof PaperclipTransitionAuthorizationError) throw error;
      throw new PaperclipTransitionAuthorizationError("authorization_persistence_failed");
    } finally {
      client.release();
    }
  }
}
