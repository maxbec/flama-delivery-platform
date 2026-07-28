BEGIN;

CREATE TABLE IF NOT EXISTS flama_delivery.repository_binding (
  repository_name text PRIMARY KEY CHECK (repository_name ~ '^(maxbec|navigaite|edilio)/[A-Za-z0-9._-]+$'),
  owner_name text NOT NULL CHECK (owner_name IN ('maxbec', 'navigaite', 'edilio')),
  company text NOT NULL CHECK (company IN ('Private', '// Navigaite', 'Edilio')),
  project_id text NOT NULL CHECK (length(project_id) > 0),
  workspace_id text NOT NULL CHECK (length(workspace_id) > 0),
  profile text NOT NULL CHECK (profile IN ('fast', 'major')),
  active boolean NOT NULL DEFAULT false,
  is_fork boolean NOT NULL,
  is_archived boolean NOT NULL,
  inventory_digest text NOT NULL CHECK (inventory_digest ~ '^sha256:[0-9a-f]{64}$'),
  verified_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (owner_name = 'maxbec' AND company = 'Private') OR
    (owner_name = 'navigaite' AND company = '// Navigaite') OR
    (owner_name = 'edilio' AND company = 'Edilio')
  ),
  CHECK (NOT active OR (NOT is_fork AND NOT is_archived)),
  CHECK (split_part(repository_name, '/', 1) = owner_name)
);

CREATE INDEX IF NOT EXISTS repository_binding_active_owner_idx
  ON flama_delivery.repository_binding (owner_name, repository_name)
  WHERE active AND NOT is_fork AND NOT is_archived;

COMMIT;
