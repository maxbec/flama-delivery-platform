import { createHash } from "node:crypto";
import { Pool, type PoolClient } from "pg";

const companies = {
  Private: {
    controller: "maxbec-delivery-controller",
    owner: "maxbec",
  },
  "// Navigaite": {
    controller: "navigaite-delivery-controller",
    owner: "navigaite",
  },
  Edilio: {
    controller: "edilio-delivery-controller",
    owner: "edilio",
  },
} as const;

type CompanyName = keyof typeof companies;
type ControllerName = typeof companies[CompanyName]["controller"];
type AuditStatus = "compliant" | "attention" | "insufficient_data";
type Environment = Readonly<Record<string, string | undefined>>;
type FetchImplementation = (input: string | URL, init?: RequestInit) => Promise<Response>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const stagePattern = /^[a-z][a-z0-9_]{0,119}$/u;
const pipelinePattern = /^[a-z][a-z0-9-]{0,119}$/u;
const maximumResponseBytes = 2 * 1024 * 1024;

export interface ReconciliationInput {
  readonly schemaVersion: 1;
  readonly company: { readonly id: string; readonly name: CompanyName };
  readonly controller: ControllerName;
  readonly controls: {
    readonly queueLagSeconds: number;
    readonly staleClaimSeconds: number;
    readonly authorizationExpiryWarningSeconds: number;
    readonly lookbackSeconds: number;
    readonly maximumAuthorizationRecords: number;
  };
  readonly mutationAllowed: false;
}

export interface QueueAuditCounts {
  readonly ready: number;
  readonly overdue: number;
  readonly staleClaims: number;
  readonly deadLettered: number;
}

export interface AuthorizationAuditCounts {
  readonly active: number;
  readonly expiring: number;
  readonly expiredUnpublished: number;
  readonly bindingDrift: number;
  readonly missingOutbox: number;
  readonly publicationMismatch: number;
  readonly overdueWithoutAuthorization: number;
}

export interface IntegrityAuditCounts {
  readonly completedWithoutTransition: number;
  readonly outboxScopeMismatch: number;
  readonly deadLetterMismatch: number;
}

export interface ReconciliationAuthorization {
  readonly idempotencyKey: string;
  readonly caseId: string;
  readonly pipelineId: string;
  readonly pipelineKey: string;
  readonly fromStageKey: string;
  readonly toStageKey: string;
  readonly published: boolean;
}

export interface ReconciliationDatabaseSnapshot {
  readonly activeBindings: number;
  readonly inbox: QueueAuditCounts;
  readonly outbox: QueueAuditCounts;
  readonly authorizations: AuthorizationAuditCounts;
  readonly integrity: IntegrityAuditCounts;
  readonly authorizationRecords: readonly ReconciliationAuthorization[];
}

export interface ReconciliationCaseDetail {
  readonly caseId: string;
  readonly companyId: string;
  readonly pipelineId: string;
  readonly pipelineKey: string;
  readonly stageKey: string;
  readonly terminalKind: string | null;
}

export interface ReconciliationTransitionEvent {
  readonly type: string;
  readonly fromStageKey: string | null;
  readonly toStageKey: string | null;
  readonly reason: string | null;
}

export interface ReconciliationDatabaseReader {
  read(input: ReconciliationInput, observedAt: Date): Promise<ReconciliationDatabaseSnapshot>;
}

export interface ReconciliationPaperclipReader {
  getCase(caseId: string): Promise<ReconciliationCaseDetail>;
  listCaseEvents(caseId: string): Promise<readonly ReconciliationTransitionEvent[]>;
}

export interface ReconciliationReaders {
  readonly database: ReconciliationDatabaseReader;
  readonly paperclip: ReconciliationPaperclipReader;
}

export interface ReconciliationEvidence {
  readonly schemaVersion: 1;
  readonly observedAt: string;
  readonly status: AuditStatus;
  readonly controller: ControllerName;
  readonly mode: "read_only";
  readonly database: {
    readonly status: AuditStatus;
    readonly activeBindings: number;
    readonly inbox: QueueAuditCounts;
    readonly outbox: QueueAuditCounts;
    readonly authorizations: AuthorizationAuditCounts;
    readonly integrity: IntegrityAuditCounts;
  };
  readonly paperclip: {
    readonly status: "compliant" | "attention" | "not_applicable";
    readonly checkedCases: number;
    readonly scopeDrift: number;
    readonly missingTransitionEvidence: number;
    readonly unrecordedTransitionEvidence: number;
    readonly stateConflict: number;
  };
}

export interface ReconciliationResult {
  readonly schemaVersion: 1;
  readonly status: "planned" | AuditStatus;
  readonly controller: ControllerName;
  readonly mode: "read_only";
  readonly contractDigest: string;
  readonly evidenceDigest?: string;
}

export type ReconciliationErrorCode =
  | "reconciliation_identity_unavailable"
  | "reconciliation_input_invalid"
  | "reconciliation_metadata_invalid"
  | "reconciliation_read_failed"
  | "reconciliation_scope_too_large";

export class ReconciliationError extends Error {
  constructor(readonly code: ReconciliationErrorCode) {
    super("reconciliation audit rejected");
    this.name = "ReconciliationError";
  }
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

function sha256(source: string): string {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

function contractDigest(input: ReconciliationInput): string {
  return sha256(JSON.stringify(stableValue({
    schemaVersion: input.schemaVersion,
    company: input.company.name,
    controller: input.controller,
    controls: input.controls,
    mode: "read_only",
  })));
}

function evidenceDigest(evidence: ReconciliationEvidence): string {
  return sha256(`${JSON.stringify(evidence, null, 2)}\n`);
}

function boundedInteger(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function validateInput(input: ReconciliationInput): void {
  const expected = companies[input.company.name];
  if (
    input.schemaVersion !== 1 || input.mutationAllowed !== false || expected === undefined ||
    expected.controller !== input.controller || !uuidPattern.test(input.company.id) ||
    !boundedInteger(input.controls.queueLagSeconds, 60, 86_400) ||
    !boundedInteger(input.controls.staleClaimSeconds, 30, 3_600) ||
    !boundedInteger(input.controls.authorizationExpiryWarningSeconds, 30, 3_600) ||
    !boundedInteger(input.controls.lookbackSeconds, 3_600, 604_800) ||
    !boundedInteger(input.controls.maximumAuthorizationRecords, 1, 1_000)
  ) throw new ReconciliationError("reconciliation_input_invalid");
}

export function planReconciliation(input: ReconciliationInput): ReconciliationResult {
  validateInput(input);
  return {
    schemaVersion: 1,
    status: "planned",
    controller: input.controller,
    mode: "read_only",
    contractDigest: contractDigest(input),
  };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function databaseStatus(snapshot: ReconciliationDatabaseSnapshot): AuditStatus {
  if (snapshot.activeBindings === 0) return "insufficient_data";
  const attention = sum([
    snapshot.inbox.overdue,
    snapshot.inbox.staleClaims,
    snapshot.inbox.deadLettered,
    snapshot.outbox.overdue,
    snapshot.outbox.staleClaims,
    snapshot.outbox.deadLettered,
    snapshot.authorizations.expiring,
    snapshot.authorizations.expiredUnpublished,
    snapshot.authorizations.bindingDrift,
    snapshot.authorizations.missingOutbox,
    snapshot.authorizations.publicationMismatch,
    snapshot.authorizations.overdueWithoutAuthorization,
    snapshot.integrity.completedWithoutTransition,
    snapshot.integrity.outboxScopeMismatch,
    snapshot.integrity.deadLetterMismatch,
  ]);
  return attention > 0 ? "attention" : "compliant";
}

function reasonFor(idempotencyKey: string): string {
  return `flama-external:sha256:${createHash("sha256").update(idempotencyKey).digest("hex")}`;
}

async function inspectPaperclip(
  input: ReconciliationInput,
  records: readonly ReconciliationAuthorization[],
  reader: ReconciliationPaperclipReader,
): Promise<ReconciliationEvidence["paperclip"]> {
  if (records.length === 0) {
    return {
      status: "not_applicable",
      checkedCases: 0,
      scopeDrift: 0,
      missingTransitionEvidence: 0,
      unrecordedTransitionEvidence: 0,
      stateConflict: 0,
    };
  }

  const cache = new Map<string, Promise<{
    readonly detail: ReconciliationCaseDetail;
    readonly events: readonly ReconciliationTransitionEvent[];
  }>>();
  const readCase = (caseId: string) => {
    let pending = cache.get(caseId);
    if (pending === undefined) {
      pending = Promise.all([reader.getCase(caseId), reader.listCaseEvents(caseId)]).then(
        ([detail, events]) => ({ detail, events }),
      );
      cache.set(caseId, pending);
    }
    return pending;
  };

  let scopeDrift = 0;
  let missingTransitionEvidence = 0;
  let unrecordedTransitionEvidence = 0;
  let stateConflict = 0;
  for (let offset = 0; offset < records.length; offset += 4) {
    const chunk = records.slice(offset, offset + 4);
    const inspected = await Promise.all(chunk.map(async (record) => ({
      record,
      observed: await readCase(record.caseId),
    })));
    for (const { record, observed } of inspected) {
      const { detail, events } = observed;
      const scoped = detail.caseId === record.caseId && detail.companyId === input.company.id &&
        detail.pipelineId === record.pipelineId && detail.pipelineKey === record.pipelineKey;
      if (!scoped) {
        scopeDrift += 1;
        continue;
      }
      const hasEvidence = events.some((event) =>
        event.type === "transitioned" && event.fromStageKey === record.fromStageKey &&
        event.toStageKey === record.toStageKey && event.reason === reasonFor(record.idempotencyKey)
      );
      if (record.published && !hasEvidence) missingTransitionEvidence += 1;
      if (!record.published && hasEvidence) unrecordedTransitionEvidence += 1;
      if (!record.published && !hasEvidence &&
        (detail.stageKey !== record.fromStageKey || detail.terminalKind !== null)) {
        stateConflict += 1;
      }
    }
  }
  const status = sum([scopeDrift, missingTransitionEvidence, unrecordedTransitionEvidence, stateConflict]) > 0
    ? "attention"
    : "compliant";
  return {
    status,
    checkedCases: cache.size,
    scopeDrift,
    missingTransitionEvidence,
    unrecordedTransitionEvidence,
    stateConflict,
  };
}

export async function auditReconciliation(
  input: ReconciliationInput,
  readers: ReconciliationReaders,
  observedAt = new Date(),
): Promise<{ readonly result: ReconciliationResult; readonly evidence: ReconciliationEvidence }> {
  validateInput(input);
  if (!Number.isFinite(observedAt.getTime())) throw new ReconciliationError("reconciliation_input_invalid");
  let snapshot: ReconciliationDatabaseSnapshot;
  let paperclip: ReconciliationEvidence["paperclip"];
  try {
    snapshot = await readers.database.read(input, observedAt);
    if (snapshot.authorizationRecords.length > input.controls.maximumAuthorizationRecords) {
      throw new ReconciliationError("reconciliation_scope_too_large");
    }
    paperclip = await inspectPaperclip(input, snapshot.authorizationRecords, readers.paperclip);
  } catch (error) {
    if (error instanceof ReconciliationError) throw error;
    throw new ReconciliationError("reconciliation_read_failed");
  }
  const dbStatus = databaseStatus(snapshot);
  const status: AuditStatus = dbStatus === "insufficient_data"
    ? "insufficient_data"
    : dbStatus === "attention" || paperclip.status === "attention"
      ? "attention"
      : "compliant";
  const evidence: ReconciliationEvidence = {
    schemaVersion: 1,
    observedAt: observedAt.toISOString(),
    status,
    controller: input.controller,
    mode: "read_only",
    database: {
      status: dbStatus,
      activeBindings: snapshot.activeBindings,
      inbox: snapshot.inbox,
      outbox: snapshot.outbox,
      authorizations: snapshot.authorizations,
      integrity: snapshot.integrity,
    },
    paperclip,
  };
  return {
    result: {
      schemaVersion: 1,
      status,
      controller: input.controller,
      mode: "read_only",
      contractDigest: contractDigest(input),
      evidenceDigest: evidenceDigest(evidence),
    },
    evidence,
  };
}

interface CountRow extends Record<string, string> {
  readonly active_bindings: string;
  readonly inbox_ready: string;
  readonly inbox_overdue: string;
  readonly inbox_stale_claims: string;
  readonly inbox_dead_lettered: string;
  readonly outbox_ready: string;
  readonly outbox_overdue: string;
  readonly outbox_stale_claims: string;
  readonly outbox_dead_lettered: string;
  readonly authorization_active: string;
  readonly authorization_expiring: string;
  readonly authorization_expired_unpublished: string;
  readonly authorization_binding_drift: string;
  readonly authorization_missing_outbox: string;
  readonly authorization_publication_mismatch: string;
  readonly overdue_without_authorization: string;
  readonly completed_without_transition: string;
  readonly outbox_scope_mismatch: string;
  readonly dead_letter_mismatch: string;
}

interface AuthorizationRow {
  readonly idempotency_key: string;
  readonly case_id: string;
  readonly pipeline_id: string;
  readonly pipeline_key: string;
  readonly from_stage_key: string;
  readonly to_stage_key: string;
  readonly published_at: Date | null;
}

function count(value: string | undefined): number {
  if (value === undefined || !/^[0-9]+$/u.test(value)) {
    throw new ReconciliationError("reconciliation_metadata_invalid");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new ReconciliationError("reconciliation_metadata_invalid");
  return parsed;
}

async function readDatabaseSnapshot(
  client: PoolClient,
  input: ReconciliationInput,
  observedAt: Date,
): Promise<ReconciliationDatabaseSnapshot> {
  const scope = companies[input.company.name];
  const values = [
    input.company.name,
    scope.owner,
    observedAt,
    input.controls.queueLagSeconds,
    input.controls.staleClaimSeconds,
    input.controls.authorizationExpiryWarningSeconds,
  ];
  const result = await client.query<CountRow>(
    `SELECT
       (SELECT count(*)::text FROM flama_delivery.repository_binding
        WHERE company = $1 AND owner_name = $2 AND active AND NOT is_fork AND NOT is_archived) AS active_bindings,
       (SELECT count(*)::text FROM flama_delivery.webhook_inbox
        WHERE owner_name = $2 AND status IN ('pending', 'retry') AND available_at <= $3::timestamptz) AS inbox_ready,
       (SELECT count(*)::text FROM flama_delivery.webhook_inbox
        WHERE owner_name = $2 AND status IN ('pending', 'retry') AND available_at <= $3::timestamptz
          AND received_at < $3::timestamptz - ($4::integer * INTERVAL '1 second')) AS inbox_overdue,
       (SELECT count(*)::text FROM flama_delivery.webhook_inbox
        WHERE owner_name = $2 AND status = 'processing'
          AND locked_at < $3::timestamptz - ($5::integer * INTERVAL '1 second')) AS inbox_stale_claims,
       (SELECT count(*)::text FROM flama_delivery.webhook_inbox
        WHERE owner_name = $2 AND status = 'dead_lettered') AS inbox_dead_lettered,
       (SELECT count(*)::text FROM flama_delivery.transition_outbox
        WHERE company = $1 AND status IN ('pending', 'retry') AND available_at <= $3::timestamptz) AS outbox_ready,
       (SELECT count(*)::text FROM flama_delivery.transition_outbox
        WHERE company = $1 AND status IN ('pending', 'retry') AND available_at <= $3::timestamptz
          AND created_at < $3::timestamptz - ($4::integer * INTERVAL '1 second')) AS outbox_overdue,
       (SELECT count(*)::text FROM flama_delivery.transition_outbox
        WHERE company = $1 AND status = 'processing'
          AND locked_at < $3::timestamptz - ($5::integer * INTERVAL '1 second')) AS outbox_stale_claims,
       (SELECT count(*)::text FROM flama_delivery.transition_outbox
        WHERE company = $1 AND status = 'dead_lettered') AS outbox_dead_lettered,
       (SELECT count(*)::text FROM flama_delivery.external_transition_authorization
        WHERE company = $1 AND revoked_at IS NULL AND published_at IS NULL AND expires_at > $3::timestamptz) AS authorization_active,
       (SELECT count(*)::text FROM flama_delivery.external_transition_authorization
        WHERE company = $1 AND revoked_at IS NULL AND published_at IS NULL AND expires_at > $3::timestamptz
          AND expires_at <= $3::timestamptz + ($6::integer * INTERVAL '1 second')) AS authorization_expiring,
       (SELECT count(*)::text FROM flama_delivery.external_transition_authorization
        WHERE company = $1 AND revoked_at IS NULL AND published_at IS NULL AND expires_at <= $3::timestamptz) AS authorization_expired_unpublished,
       (SELECT count(*)::text
        FROM flama_delivery.external_transition_authorization AS auth
        INNER JOIN flama_delivery.repository_binding AS binding
          ON binding.repository_name = auth.repository_name
        WHERE auth.company = $1 AND (
          NOT binding.active OR binding.is_fork OR binding.is_archived OR
          binding.company <> auth.company OR binding.binding_digest <> auth.binding_digest
        )) AS authorization_binding_drift,
       (SELECT count(*)::text
        FROM flama_delivery.external_transition_authorization AS auth
        LEFT JOIN flama_delivery.transition_outbox AS outbox
          ON auth.idempotency_key = 'github:' || outbox.delivery_id || ':' || outbox.transition_kind
        WHERE auth.company = $1 AND outbox.id IS NULL) AS authorization_missing_outbox,
       (SELECT count(*)::text
        FROM flama_delivery.external_transition_authorization AS auth
        INNER JOIN flama_delivery.transition_outbox AS outbox
          ON auth.idempotency_key = 'github:' || outbox.delivery_id || ':' || outbox.transition_kind
        WHERE auth.company = $1 AND (
          (auth.published_at IS NULL AND outbox.status = 'published') OR
          (auth.published_at IS NOT NULL AND outbox.status <> 'published'
            AND outbox.created_at < $3::timestamptz - ($4::integer * INTERVAL '1 second'))
        )) AS authorization_publication_mismatch,
       (SELECT count(*)::text
        FROM flama_delivery.transition_outbox AS outbox
        LEFT JOIN flama_delivery.external_transition_authorization AS auth
          ON auth.idempotency_key = 'github:' || outbox.delivery_id || ':' || outbox.transition_kind
          AND auth.revoked_at IS NULL AND auth.expires_at > $3::timestamptz
        WHERE outbox.company = $1 AND outbox.status IN ('pending', 'processing', 'retry')
          AND outbox.created_at < $3::timestamptz - ($4::integer * INTERVAL '1 second') AND auth.idempotency_key IS NULL
       ) AS overdue_without_authorization,
       (SELECT count(*)::text
        FROM flama_delivery.webhook_inbox AS inbox
        WHERE inbox.owner_name = $2 AND inbox.status = 'completed' AND NOT EXISTS (
          SELECT 1 FROM flama_delivery.transition_outbox AS outbox WHERE outbox.delivery_id = inbox.delivery_id
        )) AS completed_without_transition,
       (SELECT count(*)::text
        FROM flama_delivery.transition_outbox AS outbox
        INNER JOIN flama_delivery.webhook_inbox AS inbox ON inbox.delivery_id = outbox.delivery_id
        LEFT JOIN flama_delivery.repository_binding AS binding ON binding.repository_name = inbox.repository_name
        WHERE outbox.company = $1 AND (
          inbox.owner_name <> $2 OR binding.repository_name IS NULL OR binding.company <> outbox.company OR
          binding.owner_name <> inbox.owner_name
        )) AS outbox_scope_mismatch,
       (SELECT count(*)::text
        FROM flama_delivery.dead_letter AS dead
        INNER JOIN flama_delivery.webhook_inbox AS inbox ON inbox.delivery_id = dead.delivery_id
        LEFT JOIN flama_delivery.transition_outbox AS outbox ON outbox.id = dead.outbox_id
        WHERE inbox.owner_name = $2 AND (
          (dead.queue_name = 'inbox' AND inbox.status <> 'dead_lettered') OR
          (dead.queue_name = 'outbox' AND (outbox.id IS NULL OR outbox.status <> 'dead_lettered'))
        )) AS dead_letter_mismatch`,
    values,
  );
  const row = result.rows[0];
  if (row === undefined || result.rows.length !== 1) {
    throw new ReconciliationError("reconciliation_metadata_invalid");
  }
  const authorizationResult = await client.query<AuthorizationRow>(
    `SELECT auth.idempotency_key, auth.case_id::text,
            auth.pipeline_id::text, auth.pipeline_key,
            auth.from_stage_key, auth.to_stage_key,
            auth.published_at
     FROM flama_delivery.external_transition_authorization AS auth
     WHERE auth.company = $1 AND (
       (auth.published_at IS NOT NULL AND
        auth.authorized_at >= $2::timestamptz - ($3::integer * INTERVAL '1 second')) OR
       (auth.revoked_at IS NULL AND auth.published_at IS NULL)
     )
     ORDER BY auth.authorized_at, auth.idempotency_key
     LIMIT $4::integer`,
    [
      input.company.name,
      observedAt,
      input.controls.lookbackSeconds,
      input.controls.maximumAuthorizationRecords + 1,
    ],
  );
  const authorizationRecords = authorizationResult.rows.map((authorization) => {
    if (
      !/^github:[A-Za-z0-9._:-]{1,128}:[a-z0-9_.]+$/u.test(authorization.idempotency_key) ||
      !uuidPattern.test(authorization.case_id) || !uuidPattern.test(authorization.pipeline_id) ||
      !pipelinePattern.test(authorization.pipeline_key) || !stagePattern.test(authorization.from_stage_key) ||
      !stagePattern.test(authorization.to_stage_key)
    ) throw new ReconciliationError("reconciliation_metadata_invalid");
    return {
      idempotencyKey: authorization.idempotency_key,
      caseId: authorization.case_id,
      pipelineId: authorization.pipeline_id,
      pipelineKey: authorization.pipeline_key,
      fromStageKey: authorization.from_stage_key,
      toStageKey: authorization.to_stage_key,
      published: authorization.published_at !== null,
    };
  });
  return {
    activeBindings: count(row.active_bindings),
    inbox: {
      ready: count(row.inbox_ready),
      overdue: count(row.inbox_overdue),
      staleClaims: count(row.inbox_stale_claims),
      deadLettered: count(row.inbox_dead_lettered),
    },
    outbox: {
      ready: count(row.outbox_ready),
      overdue: count(row.outbox_overdue),
      staleClaims: count(row.outbox_stale_claims),
      deadLettered: count(row.outbox_dead_lettered),
    },
    authorizations: {
      active: count(row.authorization_active),
      expiring: count(row.authorization_expiring),
      expiredUnpublished: count(row.authorization_expired_unpublished),
      bindingDrift: count(row.authorization_binding_drift),
      missingOutbox: count(row.authorization_missing_outbox),
      publicationMismatch: count(row.authorization_publication_mismatch),
      overdueWithoutAuthorization: count(row.overdue_without_authorization),
    },
    integrity: {
      completedWithoutTransition: count(row.completed_without_transition),
      outboxScopeMismatch: count(row.outbox_scope_mismatch),
      deadLetterMismatch: count(row.dead_letter_mismatch),
    },
    authorizationRecords,
  };
}

export class PostgresReconciliationReader implements ReconciliationDatabaseReader {
  constructor(private readonly pool: Pool) {}

  async read(input: ReconciliationInput, observedAt: Date): Promise<ReconciliationDatabaseSnapshot> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SET LOCAL statement_timeout = '15s'");
      await client.query("SET LOCAL lock_timeout = '2s'");
      const snapshot = await readDatabaseSnapshot(client, input, observedAt);
      await client.query("COMMIT");
      return snapshot;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the stable reconciliation error boundary after a broken connection.
      }
      if (error instanceof ReconciliationError) throw error;
      throw new ReconciliationError("reconciliation_read_failed");
    } finally {
      client.release();
    }
  }
}

function safeDatabaseUrl(value: string | undefined): string {
  if (value === undefined || value.length > 4_096 || /[\r\n]/u.test(value)) {
    throw new ReconciliationError("reconciliation_identity_unavailable");
  }
  try {
    const parsed = new URL(value);
    if (!(parsed.protocol === "postgres:" || parsed.protocol === "postgresql:") || parsed.hostname.length === 0) {
      throw new Error("invalid");
    }
    for (const key of ["options", "application_name", "statement_timeout", "lock_timeout", "default_transaction_read_only"]) {
      if (parsed.searchParams.has(key)) throw new Error("invalid");
    }
    if (parsed.hash.length > 0) throw new Error("invalid");
  } catch {
    throw new ReconciliationError("reconciliation_identity_unavailable");
  }
  return value;
}

function safePaperclipConfig(environment: Environment): { readonly base: string; readonly key: string } {
  const rawBase = environment["PAPERCLIP_API_URL"];
  const rawKey = environment["PAPERCLIP_API_KEY"];
  if (
    rawBase === undefined || rawKey === undefined || rawKey.length < 20 || rawKey.length > 4_096 ||
    /[\r\n]/u.test(rawKey)
  ) throw new ReconciliationError("reconciliation_identity_unavailable");
  let parsed: URL;
  try {
    parsed = new URL(rawBase);
  } catch {
    throw new ReconciliationError("reconciliation_identity_unavailable");
  }
  const loopback = parsed.protocol === "http:" &&
    ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname);
  if ((parsed.protocol !== "https:" && !loopback) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ReconciliationError("reconciliation_identity_unavailable");
  }
  return { base: parsed.toString().replace(/\/+$/u, ""), key: rawKey };
}

async function boundedJson(response: Response): Promise<unknown> {
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new ReconciliationError("reconciliation_read_failed");
  }
  const contentType = response.headers.get("content-type");
  const contentLength = response.headers.get("content-length");
  if (
    contentType === null || !/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/iu.test(contentType) ||
    (contentLength !== null && (!/^[0-9]+$/u.test(contentLength) || Number(contentLength) > maximumResponseBytes))
  ) {
    await response.body?.cancel();
    throw new ReconciliationError("reconciliation_metadata_invalid");
  }
  let source: string;
  try {
    source = await response.text();
  } catch {
    throw new ReconciliationError("reconciliation_metadata_invalid");
  }
  if (Buffer.byteLength(source, "utf8") > maximumResponseBytes) {
    throw new ReconciliationError("reconciliation_metadata_invalid");
  }
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new ReconciliationError("reconciliation_metadata_invalid");
  }
}

export class PaperclipReadOnlyReconciliationReader implements ReconciliationPaperclipReader {
  readonly #base: string;
  readonly #key: string;

  constructor(environment: Environment, private readonly fetchImplementation: FetchImplementation = fetch) {
    const config = safePaperclipConfig(environment);
    this.#base = config.base;
    this.#key = config.key;
  }

  async #get(path: string): Promise<unknown> {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || /[\r\n]/u.test(path)) {
      throw new ReconciliationError("reconciliation_read_failed");
    }
    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.#base}${path}`, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.#key}`,
          "User-Agent": "flama-delivery-reconciler/0.1.0",
        },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ReconciliationError("reconciliation_read_failed");
    }
    return boundedJson(response);
  }

  async getCase(caseId: string): Promise<ReconciliationCaseDetail> {
    if (!uuidPattern.test(caseId)) throw new ReconciliationError("reconciliation_metadata_invalid");
    const value = await this.#get(`/api/cases/${encodeURIComponent(caseId)}`);
    if (!isRecord(value) || !isRecord(value["case"]) || !isRecord(value["stage"]) || !isRecord(value["pipeline"])) {
      throw new ReconciliationError("reconciliation_metadata_invalid");
    }
    const caseValue = value["case"];
    const stage = value["stage"];
    const pipeline = value["pipeline"];
    const detail: ReconciliationCaseDetail = {
      caseId: typeof caseValue["id"] === "string" ? caseValue["id"] : "",
      companyId: typeof caseValue["companyId"] === "string" ? caseValue["companyId"] : "",
      pipelineId: typeof caseValue["pipelineId"] === "string" ? caseValue["pipelineId"] : "",
      pipelineKey: typeof pipeline["key"] === "string" ? pipeline["key"] : "",
      stageKey: typeof stage["key"] === "string" ? stage["key"] : "",
      terminalKind: caseValue["terminalKind"] === null || typeof caseValue["terminalKind"] === "string"
        ? caseValue["terminalKind"]
        : "invalid",
    };
    if (
      !uuidPattern.test(detail.caseId) || !uuidPattern.test(detail.companyId) ||
      !uuidPattern.test(detail.pipelineId) || pipeline["id"] !== detail.pipelineId ||
      pipeline["companyId"] !== detail.companyId || !pipelinePattern.test(detail.pipelineKey) ||
      !stagePattern.test(detail.stageKey)
    ) throw new ReconciliationError("reconciliation_metadata_invalid");
    return detail;
  }

  async listCaseEvents(caseId: string): Promise<readonly ReconciliationTransitionEvent[]> {
    if (!uuidPattern.test(caseId)) throw new ReconciliationError("reconciliation_metadata_invalid");
    const events: ReconciliationTransitionEvent[] = [];
    for (let offset = 0; offset < 1_000; offset += 100) {
      const value = await this.#get(`/api/cases/${encodeURIComponent(caseId)}/events?limit=100&offset=${offset}`);
      if (!isRecord(value) || !Array.isArray(value["items"]) || !isRecord(value["pagination"])) {
        throw new ReconciliationError("reconciliation_metadata_invalid");
      }
      for (const item of value["items"]) {
        if (!isRecord(item)) throw new ReconciliationError("reconciliation_metadata_invalid");
        const payload = isRecord(item["payload"]) ? item["payload"] : {};
        const fromStage = isRecord(item["fromStage"]) ? item["fromStage"] : undefined;
        const toStage = isRecord(item["toStage"]) ? item["toStage"] : undefined;
        const event = {
          type: typeof item["type"] === "string" ? item["type"] : "",
          fromStageKey: typeof fromStage?.["key"] === "string" ? fromStage["key"] : null,
          toStageKey: typeof toStage?.["key"] === "string" ? toStage["key"] : null,
          reason: typeof payload["reason"] === "string" ? payload["reason"] : null,
        };
        if (
          !/^[a-z_]{1,120}$/u.test(event.type) ||
          (event.fromStageKey !== null && !stagePattern.test(event.fromStageKey)) ||
          (event.toStageKey !== null && !stagePattern.test(event.toStageKey)) ||
          (event.reason !== null && (event.reason.length > 512 || /[\u0000-\u001f\u007f]/u.test(event.reason)))
        ) throw new ReconciliationError("reconciliation_metadata_invalid");
        events.push(event);
      }
      const pagination = value["pagination"];
      if (pagination["hasMore"] === false && pagination["nextOffset"] === null) return events;
      if (pagination["hasMore"] !== true || pagination["nextOffset"] !== offset + 100) {
        throw new ReconciliationError("reconciliation_metadata_invalid");
      }
    }
    throw new ReconciliationError("reconciliation_scope_too_large");
  }
}

export interface ReconciliationRuntime extends ReconciliationReaders {
  close(): Promise<void>;
}

export function createReconciliationRuntime(
  environment: Environment,
  fetchImplementation: FetchImplementation = fetch,
): ReconciliationRuntime {
  const connectionString = safeDatabaseUrl(environment["DATABASE_URL"]);
  const paperclip = new PaperclipReadOnlyReconciliationReader(environment, fetchImplementation);
  const pool = new Pool({
    connectionString,
    max: 1,
    application_name: "flama-delivery-reconciler",
    options: "-c default_transaction_read_only=on -c statement_timeout=15000 -c lock_timeout=2000",
  });
  return {
    database: new PostgresReconciliationReader(pool),
    paperclip,
    async close() {
      await pool.end();
    },
  };
}
