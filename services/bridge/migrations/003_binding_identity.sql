BEGIN;

ALTER TABLE flama_delivery.repository_binding
  ADD COLUMN IF NOT EXISTS github_repository_id bigint CHECK (github_repository_id > 0),
  ADD COLUMN IF NOT EXISTS default_branch text CHECK (
    length(default_branch) BETWEEN 1 AND 255 AND
    default_branch !~ '[[:cntrl:][:space:]~^:?*\[\\]' AND
    default_branch !~ '\.\.' AND
    default_branch !~ '//'
  ),
  ADD COLUMN IF NOT EXISTS binding_digest text CHECK (binding_digest ~ '^sha256:[0-9a-f]{64}$');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'repository_binding_active_identity_check'
      AND conrelid = 'flama_delivery.repository_binding'::regclass
  ) THEN
    ALTER TABLE flama_delivery.repository_binding
      ADD CONSTRAINT repository_binding_active_identity_check CHECK (
        NOT active OR (
          github_repository_id IS NOT NULL AND
          default_branch IS NOT NULL AND
          binding_digest IS NOT NULL AND
          project_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' AND
          workspace_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
        )
      );
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS repository_binding_active_workspace_idx
  ON flama_delivery.repository_binding (company, workspace_id)
  WHERE active AND NOT is_fork AND NOT is_archived;

COMMIT;
