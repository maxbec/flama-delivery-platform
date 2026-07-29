BEGIN;

CREATE INDEX IF NOT EXISTS webhook_inbox_reconciliation_idx
  ON flama_delivery.webhook_inbox (owner_name, status, received_at);

CREATE INDEX IF NOT EXISTS transition_outbox_reconciliation_idx
  ON flama_delivery.transition_outbox (company, status, created_at);

CREATE INDEX IF NOT EXISTS external_transition_authorization_reconciliation_idx
  ON flama_delivery.external_transition_authorization (company, authorized_at, idempotency_key);

CREATE INDEX IF NOT EXISTS external_transition_authorization_unpublished_idx
  ON flama_delivery.external_transition_authorization (company, expires_at)
  WHERE revoked_at IS NULL AND published_at IS NULL;

COMMIT;
