BEGIN;

CREATE SCHEMA IF NOT EXISTS flama_delivery;

CREATE TABLE IF NOT EXISTS flama_delivery.webhook_inbox (
  delivery_id text PRIMARY KEY,
  event_name text NOT NULL,
  owner_name text NOT NULL CHECK (owner_name IN ('maxbec', 'navigaite', 'edilio')),
  repository_name text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'retry', 'completed', 'dead_lettered')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  received_at timestamp with time zone NOT NULL,
  locked_at timestamp with time zone,
  locked_by text,
  processed_at timestamp with time zone,
  last_error_code text,
  CHECK ((status = 'processing') = (locked_at IS NOT NULL AND locked_by IS NOT NULL)),
  CHECK ((status = 'completed') = (processed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS webhook_inbox_ready_idx
  ON flama_delivery.webhook_inbox (available_at, received_at)
  WHERE status IN ('pending', 'retry');

CREATE TABLE IF NOT EXISTS flama_delivery.transition_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  delivery_id text NOT NULL REFERENCES flama_delivery.webhook_inbox (delivery_id) ON DELETE RESTRICT,
  company text NOT NULL CHECK (company IN ('Private', '// Navigaite', 'Edilio')),
  transition_kind text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'retry', 'published', 'dead_lettered')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  locked_at timestamp with time zone,
  locked_by text,
  published_at timestamp with time zone,
  last_error_code text,
  UNIQUE (delivery_id, transition_kind),
  CHECK ((status = 'processing') = (locked_at IS NOT NULL AND locked_by IS NOT NULL)),
  CHECK ((status = 'published') = (published_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS transition_outbox_delivery_id_idx
  ON flama_delivery.transition_outbox (delivery_id);

CREATE INDEX IF NOT EXISTS transition_outbox_ready_idx
  ON flama_delivery.transition_outbox (available_at, created_at)
  WHERE status IN ('pending', 'retry');

CREATE TABLE IF NOT EXISTS flama_delivery.dead_letter (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  queue_name text NOT NULL CHECK (queue_name IN ('inbox', 'outbox')),
  delivery_id text NOT NULL REFERENCES flama_delivery.webhook_inbox (delivery_id) ON DELETE RESTRICT,
  outbox_id bigint REFERENCES flama_delivery.transition_outbox (id) ON DELETE RESTRICT,
  reason_code text NOT NULL,
  attempt_count integer NOT NULL CHECK (attempt_count > 0),
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (queue_name = 'inbox' AND outbox_id IS NULL) OR
    (queue_name = 'outbox' AND outbox_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS dead_letter_delivery_id_idx
  ON flama_delivery.dead_letter (delivery_id);

CREATE INDEX IF NOT EXISTS dead_letter_outbox_id_idx
  ON flama_delivery.dead_letter (outbox_id)
  WHERE outbox_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS dead_letter_inbox_unique_idx
  ON flama_delivery.dead_letter (delivery_id)
  WHERE queue_name = 'inbox';

CREATE UNIQUE INDEX IF NOT EXISTS dead_letter_outbox_unique_idx
  ON flama_delivery.dead_letter (outbox_id)
  WHERE queue_name = 'outbox';

COMMIT;
