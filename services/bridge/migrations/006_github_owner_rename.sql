BEGIN;

-- The Edilio company's GitHub owner is the organization edilio-app. Earlier
-- migrations encoded the owner as `edilio`, which is an unrelated personal
-- account. Databases created before this migration carry the wrong constraint;
-- databases created from the corrected 001/002 already have the right one, so
-- every statement here is written to be safe in both cases.

ALTER TABLE flama_delivery.webhook_inbox
  DROP CONSTRAINT IF EXISTS webhook_inbox_owner_name_check;
ALTER TABLE flama_delivery.webhook_inbox
  ADD CONSTRAINT webhook_inbox_owner_name_check
  CHECK (owner_name IN ('maxbec', 'navigaite', 'edilio-app'));

ALTER TABLE flama_delivery.repository_binding
  DROP CONSTRAINT IF EXISTS repository_binding_repository_name_check;
ALTER TABLE flama_delivery.repository_binding
  ADD CONSTRAINT repository_binding_repository_name_check
  CHECK (repository_name ~ '^(maxbec|navigaite|edilio-app)/[A-Za-z0-9._-]+$');

ALTER TABLE flama_delivery.repository_binding
  DROP CONSTRAINT IF EXISTS repository_binding_owner_name_check;
ALTER TABLE flama_delivery.repository_binding
  ADD CONSTRAINT repository_binding_owner_name_check
  CHECK (owner_name IN ('maxbec', 'navigaite', 'edilio-app'));

ALTER TABLE flama_delivery.repository_binding
  DROP CONSTRAINT IF EXISTS repository_binding_check;
ALTER TABLE flama_delivery.repository_binding
  ADD CONSTRAINT repository_binding_check
  CHECK (
    (owner_name = 'maxbec' AND company = 'Private') OR
    (owner_name = 'navigaite' AND company = '// Navigaite') OR
    (owner_name = 'edilio-app' AND company = 'Edilio')
  );

COMMIT;
