# Deployment provider contract

Every provider adapter implements `validate`, `deploy`, `health`, `rollback`,
`deploymentUrl`, `deployedVersion`, and `evidence`. The orchestrator accepts an
already-built artifact reference and never rebuilds source.

Repository adapters export `createAdapter` from `.flama/provider.cjs`. CommonJS
is intentional: the immutable single-file CLI loads that trusted protected-branch
module through Node's runtime `createRequire`, outside ncc's compile-time graph.

The provider-neutral state machine:

1. Rejects a soak shorter than 600 seconds or rollback limits other than one.
2. Runs adapter validation before mutation.
3. Deploys the immutable artifact reference once.
4. Verifies health, exact version, and repository smoke behavior immediately.
5. Repeats all three checks through the full soak window.
6. Rolls back to the previous artifact at most once after any failure.
7. Emits schema-validated evidence with digests and non-secret provider IDs.

The current implementation is exercised only with fake adapters. Concrete
provider configuration and credentials remain Phase 3/4 work and require the
approved Infisical and canary boundaries; this code does not authorize a live
deployment.
