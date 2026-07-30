# Phase 3 policy evidence

This checkpoint implements the metadata-only Infisical policy boundary. It does
not install a GitHub App, create or read an Infisical credential, configure an
identity, sync a value, change a destination secret, modify a repository, or
alter GitHub settings.

Implemented controls:

- `secrets-audit` accepts secret names and configuration metadata but has no
  field for a secret value.
- Infisical must remain authoritative with explicit project,
  environment, and canonical path mappings.
- GitHub Actions access requires a non-shared, short-lived OIDC identity scoped
  to the project, environment, and path with exact issuer, audience, repository,
  workflow, and ref/environment claims.
- Public and fork pull-request execution cannot receive secrets, OIDC,
  Infisical access, trusted cache writes, private runners, production network
  access, or `pull_request_target` execution.
- Build and release jobs cannot receive production secrets. Production access
  remains bound to the approved deployment path and exact approval boundary.
- Secret Syncs require an explicit destination scope and key selection,
  automatic rotation, a deliberate initial-overwrite policy, and connection
  credentials sourced from Infisical. Broad all-repository syncs fail.
- A direct destination secret must have a matching current approved exception.
  Synced secrets cannot simultaneously claim an exception path. Duplicate,
  orphaned, expired, review-due, rotation-due, future-dated, or scope-mismatched
  records fail closed.
- The Paperclip HMAC routine installer applies this same rule to the verifier
  copy that released Paperclip necessarily retains: live creation requires an
  exact current `provider_native_secret` exception, while the bridge receives
  its runtime copy from the authoritative Infisical path. A digest of the
  exception is emitted; its owner and reason are not.
- Repository variables, generated configuration, and Paperclip prompts are
  audited by classification. A secret-classified field fails without returning
  its name.
- Results contain only stable finding codes and coarse locations. They do not
  return project slugs, paths, identity IDs, secret names, reasons, owners, or
  values.
- `github-policy-audit` compares normalized read-only observations with the
  exact Fast/Major default branches, required checks, protection controls,
  profile-specific merge methods, Actions permissions/pinning, available
  security features, version-tag and immutable-release controls, deployment
  review boundary, owner-scoped selected-repository App posture, and separated
  preflight/verification/deployment runners. Its result is identifier-free and
  includes only drift codes plus a policy digest.

Still pending:

- authoritative private project/environment/path and identity mappings;
- scoped GitHub App installation and permission verification;
- authoritative read-only collection of repository rulesets, Actions settings,
  Dependabot, security features, app/webhook permissions, and runner separation
  into the normalized audit input;
- explicit review and approval of any real destination-secret exceptions;
- explicit review of the Paperclip verifier-copy exception before any live
  HMAC trigger is created;
- live OIDC, Secret Sync, and rotation tests in the Phase 4 canaries.

Those inputs must be collected privately from authoritative APIs. The platform
will not infer them from repository names, Paperclip projects, or existing
destination configuration. This evidence authorizes no credential retrieval,
secret migration, repository mutation, or production change.
