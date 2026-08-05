BEGIN;

CREATE TABLE IF NOT EXISTS flama_delivery.external_transition_authorization (
  idempotency_key text PRIMARY KEY
    CHECK (idempotency_key ~ '^github:[A-Za-z0-9._:-]{1,128}:[a-z0-9_.]+$'),
  repository_name text NOT NULL
    REFERENCES flama_delivery.repository_binding (repository_name) ON DELETE RESTRICT,
  company text NOT NULL CHECK (company IN ('Private', '// Navigaite', 'Edilio')),
  controller_name text NOT NULL CHECK (
    (company = 'Private' AND controller_name = 'maxbec-delivery-controller') OR
    (company = '// Navigaite' AND controller_name = 'navigaite-delivery-controller') OR
    (company = 'Edilio' AND controller_name = 'edilio-delivery-controller')
  ),
  case_id uuid NOT NULL,
  pipeline_id uuid NOT NULL,
  pipeline_key text NOT NULL CHECK (pipeline_key IN (
    'flama-project-bootstrap-v1',
    'flama-feature-fix-v1',
    'flama-release-deployment-v1'
  )),
  transition_kind text NOT NULL,
  from_stage_key text NOT NULL CHECK (from_stage_key ~ '^[a-z][a-z0-9_]{0,119}$'),
  to_stage_key text NOT NULL CHECK (to_stage_key ~ '^[a-z][a-z0-9_]{0,119}$'),
  event_digest text NOT NULL CHECK (event_digest ~ '^sha256:[0-9a-f]{64}$'),
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  binding_digest text NOT NULL CHECK (binding_digest ~ '^sha256:[0-9a-f]{64}$'),
  authorized_at timestamp with time zone NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  revoked_at timestamp with time zone,
  published_at timestamp with time zone,
  CHECK (expires_at > authorized_at),
  CHECK (expires_at <= authorized_at + INTERVAL '1 hour'),
  CHECK (revoked_at IS NULL OR revoked_at >= authorized_at),
  CHECK (published_at IS NULL OR published_at >= authorized_at),
  CHECK (
    (pipeline_key = 'flama-project-bootstrap-v1' AND
      transition_kind = 'workflow_run.completed' AND
      from_stage_key = 'repository_prepared' AND to_stage_key = 'baseline_green') OR
    (pipeline_key = 'flama-feature-fix-v1' AND
      transition_kind IN ('pull_request.opened', 'pull_request.reopened', 'pull_request.ready_for_review') AND
      from_stage_key = 'preflight_passed' AND to_stage_key = 'pr_open') OR
    (pipeline_key = 'flama-feature-fix-v1' AND
      transition_kind = 'pull_request.merged' AND
      from_stage_key = 'pr_open' AND to_stage_key = 'merged') OR
    (pipeline_key = 'flama-release-deployment-v1' AND
      transition_kind = 'release.published' AND
      from_stage_key = 'production_verification' AND to_stage_key = 'released') OR
    (pipeline_key = 'flama-release-deployment-v1' AND
      transition_kind IN ('pull_request.opened', 'pull_request.reopened', 'pull_request.ready_for_review') AND
      from_stage_key = 'released' AND to_stage_key = 'deployment_pr_open') OR
    (pipeline_key = 'flama-release-deployment-v1' AND
      transition_kind = 'pull_request.merged' AND
      from_stage_key = 'awaiting_owner_approval' AND to_stage_key = 'deploying') OR
    (pipeline_key = 'flama-release-deployment-v1' AND
      transition_kind = 'deployment_status.success' AND
      from_stage_key = 'deploying' AND to_stage_key = 'verified')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS external_transition_authorization_exact_event_idx
  ON flama_delivery.external_transition_authorization
    (case_id, from_stage_key, to_stage_key, event_digest);

CREATE INDEX IF NOT EXISTS external_transition_authorization_active_idx
  ON flama_delivery.external_transition_authorization (repository_name, expires_at)
  WHERE revoked_at IS NULL AND published_at IS NULL;

COMMIT;
