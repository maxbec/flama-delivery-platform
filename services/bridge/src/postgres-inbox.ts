import type { Pool, PoolClient } from "pg";
import type {
  ClaimedWebhook,
  ClaimedTransition,
  DeliveryFailure,
  EnqueueWebhook,
  Transition,
  TransitionFailure,
  WebhookEnvelope,
} from "./inbox.js";

interface ClaimedRow {
  readonly delivery_id: string;
  readonly event_name: string;
  readonly owner_name: string;
  readonly repository_name: string;
  readonly payload: Record<string, unknown>;
  readonly received_at: Date;
  readonly attempts: number;
}

interface FailureRow {
  readonly attempts: number;
}

interface ClaimedTransitionRow {
  readonly id: string;
  readonly delivery_id: string;
  readonly company: "Private" | "// Navigaite" | "Edilio";
  readonly transition_kind: string;
  readonly payload: Record<string, unknown>;
  readonly attempts: number;
}

interface TransitionFailureRow extends FailureRow {
  readonly delivery_id: string;
}

export interface RecoveryResult {
  readonly inboxRetried: number;
  readonly inboxDeadLettered: number;
  readonly outboxRetried: number;
  readonly outboxDeadLettered: number;
}

async function inTransaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export class PostgresInbox implements EnqueueWebhook {
  constructor(private readonly pool: Pool) {}

  async check(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async recoverStaleClaims(maxAgeSeconds: number, maxAttempts: number): Promise<RecoveryResult> {
    if (
      !Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 30 || maxAgeSeconds > 3_600 ||
      !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20
    ) throw new Error("invalid recovery bounds");

    return inTransaction(this.pool, async (client) => {
      const inboxDead = await client.query(
        `WITH stale AS (
           UPDATE flama_delivery.webhook_inbox
           SET status = 'dead_lettered', locked_at = NULL, locked_by = NULL,
               last_error_code = 'stale_claim_exhausted'
           WHERE status = 'processing'
             AND locked_at < CURRENT_TIMESTAMP - ($1 * INTERVAL '1 second')
             AND attempts >= $2
           RETURNING delivery_id, attempts
         )
         INSERT INTO flama_delivery.dead_letter
           (queue_name, delivery_id, reason_code, attempt_count)
         SELECT 'inbox', delivery_id, 'stale_claim_exhausted', attempts
         FROM stale
         ON CONFLICT DO NOTHING`,
        [maxAgeSeconds, maxAttempts],
      );
      const outboxDead = await client.query(
        `WITH stale AS (
           UPDATE flama_delivery.transition_outbox
           SET status = 'dead_lettered', locked_at = NULL, locked_by = NULL,
               last_error_code = 'stale_claim_exhausted'
           WHERE status = 'processing'
             AND locked_at < CURRENT_TIMESTAMP - ($1 * INTERVAL '1 second')
             AND attempts >= $2
           RETURNING id, delivery_id, attempts
         )
         INSERT INTO flama_delivery.dead_letter
           (queue_name, delivery_id, outbox_id, reason_code, attempt_count)
         SELECT 'outbox', delivery_id, id, 'stale_claim_exhausted', attempts
         FROM stale
         ON CONFLICT DO NOTHING`,
        [maxAgeSeconds, maxAttempts],
      );
      const inboxRetry = await client.query(
        `UPDATE flama_delivery.webhook_inbox
         SET status = 'retry', locked_at = NULL, locked_by = NULL,
             last_error_code = 'stale_claim_recovered', available_at = CURRENT_TIMESTAMP
         WHERE status = 'processing'
           AND locked_at < CURRENT_TIMESTAMP - ($1 * INTERVAL '1 second')
           AND attempts < $2`,
        [maxAgeSeconds, maxAttempts],
      );
      const outboxRetry = await client.query(
        `UPDATE flama_delivery.transition_outbox
         SET status = 'retry', locked_at = NULL, locked_by = NULL,
             last_error_code = 'stale_claim_recovered', available_at = CURRENT_TIMESTAMP
         WHERE status = 'processing'
           AND locked_at < CURRENT_TIMESTAMP - ($1 * INTERVAL '1 second')
           AND attempts < $2`,
        [maxAgeSeconds, maxAttempts],
      );
      return {
        inboxRetried: inboxRetry.rowCount ?? 0,
        inboxDeadLettered: inboxDead.rowCount ?? 0,
        outboxRetried: outboxRetry.rowCount ?? 0,
        outboxDeadLettered: outboxDead.rowCount ?? 0,
      };
    });
  }

  async enqueue(envelope: WebhookEnvelope): Promise<"accepted" | "duplicate"> {
    const result = await this.pool.query(
      `INSERT INTO flama_delivery.webhook_inbox
        (delivery_id, event_name, owner_name, repository_name, payload, received_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT (delivery_id) DO NOTHING`,
      [
        envelope.deliveryId,
        envelope.eventName,
        envelope.owner,
        envelope.repository,
        JSON.stringify(envelope.payload),
        envelope.receivedAt,
      ],
    );
    return result.rowCount === 1 ? "accepted" : "duplicate";
  }

  async claimNext(workerId: string): Promise<ClaimedWebhook | undefined> {
    const result = await this.pool.query<ClaimedRow>(
      `WITH candidate AS (
         SELECT delivery_id
         FROM flama_delivery.webhook_inbox
         WHERE status IN ('pending', 'retry') AND available_at <= CURRENT_TIMESTAMP
         ORDER BY available_at, received_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE flama_delivery.webhook_inbox AS inbox
       SET status = 'processing',
           attempts = inbox.attempts + 1,
           locked_at = CURRENT_TIMESTAMP,
           locked_by = $1,
           last_error_code = NULL
       FROM candidate
       WHERE inbox.delivery_id = candidate.delivery_id
       RETURNING inbox.delivery_id, inbox.event_name, inbox.owner_name,
                 inbox.repository_name, inbox.payload, inbox.received_at, inbox.attempts`,
      [workerId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      deliveryId: row.delivery_id,
      eventName: row.event_name,
      owner: row.owner_name,
      repository: row.repository_name,
      payload: row.payload,
      receivedAt: row.received_at,
      attempts: row.attempts,
    };
  }

  async completeWithTransition(transition: Transition): Promise<void> {
    await inTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO flama_delivery.transition_outbox
          (delivery_id, company, transition_kind, payload)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (delivery_id, transition_kind) DO NOTHING`,
        [
          transition.deliveryId,
          transition.company,
          transition.transitionKind,
          JSON.stringify(transition.payload),
        ],
      );
      const completed = await client.query(
        `UPDATE flama_delivery.webhook_inbox
         SET status = 'completed', processed_at = CURRENT_TIMESTAMP,
             locked_at = NULL, locked_by = NULL, last_error_code = NULL
         WHERE delivery_id = $1 AND status IN ('processing', 'completed')`,
        [transition.deliveryId],
      );
      if (completed.rowCount !== 1) {
        throw new Error("delivery is not claimable for completion");
      }
    });
  }

  async claimNextTransition(workerId: string): Promise<ClaimedTransition | undefined> {
    const result = await this.pool.query<ClaimedTransitionRow>(
      `WITH candidate AS (
         SELECT id
         FROM flama_delivery.transition_outbox
         WHERE status IN ('pending', 'retry') AND available_at <= CURRENT_TIMESTAMP
         ORDER BY available_at, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE flama_delivery.transition_outbox AS outbox
       SET status = 'processing',
           attempts = outbox.attempts + 1,
           locked_at = CURRENT_TIMESTAMP,
           locked_by = $1,
           last_error_code = NULL
       FROM candidate
       WHERE outbox.id = candidate.id
       RETURNING outbox.id, outbox.delivery_id, outbox.company,
                 outbox.transition_kind, outbox.payload, outbox.attempts`,
      [workerId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      id: row.id,
      deliveryId: row.delivery_id,
      company: row.company,
      transitionKind: row.transition_kind,
      payload: row.payload,
      attempts: row.attempts,
    };
  }

  async markTransitionPublished(id: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE flama_delivery.transition_outbox
       SET status = 'published', published_at = CURRENT_TIMESTAMP,
           locked_at = NULL, locked_by = NULL, last_error_code = NULL
       WHERE id = $1 AND status = 'processing'`,
      [id],
    );
    if (result.rowCount !== 1) throw new Error("transition is not processing");
  }

  async failTransition(
    failure: TransitionFailure,
  ): Promise<"retry_scheduled" | "dead_lettered"> {
    return inTransaction(this.pool, async (client) => {
      const selected = await client.query<TransitionFailureRow>(
        `SELECT delivery_id, attempts
         FROM flama_delivery.transition_outbox
         WHERE id = $1 AND status = 'processing'
         FOR UPDATE`,
        [failure.id],
      );
      const row = selected.rows[0];
      if (row === undefined) throw new Error("transition is not processing");

      if (row.attempts >= failure.maxAttempts) {
        await client.query(
          `INSERT INTO flama_delivery.dead_letter
            (queue_name, delivery_id, outbox_id, reason_code, attempt_count)
           VALUES ('outbox', $1, $2, $3, $4)
           ON CONFLICT DO NOTHING`,
          [row.delivery_id, failure.id, failure.reasonCode, row.attempts],
        );
        await client.query(
          `UPDATE flama_delivery.transition_outbox
           SET status = 'dead_lettered', locked_at = NULL, locked_by = NULL,
               last_error_code = $2
           WHERE id = $1`,
          [failure.id, failure.reasonCode],
        );
        return "dead_lettered";
      }

      const retryDelaySeconds = Math.min(300, 2 ** row.attempts);
      await client.query(
        `UPDATE flama_delivery.transition_outbox
         SET status = 'retry', locked_at = NULL, locked_by = NULL,
             last_error_code = $2,
             available_at = CURRENT_TIMESTAMP + ($3 * INTERVAL '1 second')
         WHERE id = $1`,
        [failure.id, failure.reasonCode, retryDelaySeconds],
      );
      return "retry_scheduled";
    });
  }

  async fail(failure: DeliveryFailure): Promise<"retry_scheduled" | "dead_lettered"> {
    return inTransaction(this.pool, async (client) => {
      const selected = await client.query<FailureRow>(
        `SELECT attempts
         FROM flama_delivery.webhook_inbox
         WHERE delivery_id = $1 AND status = 'processing'
         FOR UPDATE`,
        [failure.deliveryId],
      );
      const row = selected.rows[0];
      if (row === undefined) throw new Error("delivery is not processing");

      if (row.attempts >= failure.maxAttempts) {
        await client.query(
          `INSERT INTO flama_delivery.dead_letter
            (queue_name, delivery_id, reason_code, attempt_count)
           VALUES ('inbox', $1, $2, $3)
           ON CONFLICT DO NOTHING`,
          [failure.deliveryId, failure.reasonCode, row.attempts],
        );
        await client.query(
          `UPDATE flama_delivery.webhook_inbox
           SET status = 'dead_lettered', locked_at = NULL, locked_by = NULL,
               last_error_code = $2
           WHERE delivery_id = $1`,
          [failure.deliveryId, failure.reasonCode],
        );
        return "dead_lettered";
      }

      const retryDelaySeconds = Math.min(300, 2 ** row.attempts);
      await client.query(
        `UPDATE flama_delivery.webhook_inbox
         SET status = 'retry', locked_at = NULL, locked_by = NULL,
             last_error_code = $2,
             available_at = CURRENT_TIMESTAMP + ($3 * INTERVAL '1 second')
         WHERE delivery_id = $1`,
        [failure.deliveryId, failure.reasonCode, retryDelaySeconds],
      );
      return "retry_scheduled";
    });
  }
}
