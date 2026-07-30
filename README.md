# Flama Delivery Platform

The central, public source of truth for deterministic software delivery across
the `maxbec`, `navigaite`, and `edilio` GitHub owners and their matching
Paperclip companies.

The target lifecycle is:

```text
Paperclip project → ready task → isolated implementation → signed preflight
→ protected merge → semantic release → owner-approved deployment PR
→ immutable artifact deployment → health/soak verification or rollback
→ reconciled Paperclip evidence
```

## Current implementation status

The consolidated, dated checkpoint is maintained in
[Implementation progress](docs/implementation-progress.md). The summary below
retains the major safety and phase boundaries.

- Phase 0 live inventory is complete and reproducible with
  `scripts/phase0-inventory.sh`.
- 64 consumer repositories are in scope.
- 28 forks and 3 archived repositories are inventory-only and denied mutation.
- This repository is tracked separately as the platform, not as consumer 65.
- Consumer repositories have not been changed.
- The legacy v3 implementation remains in `navigaite/.github` until the final
  completion audit passes.
- Phase 1 runtime foundations use Node.js 26, TypeScript, pnpm workspaces,
  Fastify, AJV, and a PostgreSQL 18 durable inbox/outbox.
- `flama-delivery-ctl` currently implements secret-safe `validate`, `inventory`,
  `classify`, `bootstrap`, `render`, `paperclip-foundation`, `preflight`,
  `paperclip-controllers`, `paperclip-bindings`,
  `paperclip-transition-authorize`, `paperclip-routines`, `reconcile`,
  `publish-check`, `promote`, `release-evidence`, `deployment-pr`, `deploy`,
  `github-policy-audit`, `secrets-audit`, `canary-plan`, and `canary-audit`
  JSON commands.
  Remaining lifecycle commands are added only with their executable
  provider/evidence contracts.
- The bridge authenticates GitHub webhook bytes before parsing, minimizes
  accepted payloads before persistence, requires a private active repository
  binding at intake and processing, deduplicates deliveries, replays stale
  claims, and bounds inbox/outbox retries with payload-free dead-letter records.
- Reconciliation now has an executable read-only audit boundary: PostgreSQL is
  forced into a repeatable-read read-only transaction, Paperclip transport is
  GET-only, scans are bounded, detailed metadata is create-only mode `0600`,
  and ordinary output is digest-only. It does not replay dead letters, infer
  mappings, or discover missed GitHub events without later private selectors.
- The validated `flama-paperclip-delivery` skill and enforced canonical
  lifecycle pipelines are installed in the approved live Paperclip scope from
  pinned source. Two zero-budget company controllers are verified paused; the
  remaining native hire request is still behind Paperclip's board approval and
  has not been bypassed.
- The governance controller is implemented as a deterministic Node.js 26 job
  orchestrated by Paperclip. Company-local controllers supply bounded
  Paperclip attestations through their native run context; the aggregator does
  not poll Paperclip or hold board credentials. It uses distinct read-only
  GitHub App identities per owner, metadata-only aggregation, and mode-0600
  private evidence; live collection remains gated on those App identities,
  controller attestations, and private selectors.
- Production deployment has a separate exact-SHA trust gate, strict manifest
  validation, provider-neutral health/version/smoke soak, and one-attempt
  rollback state machine. No concrete provider is configured or invoked here.
- Platform release packaging produces reproducible self-contained CLI,
  bridge, company-controller, and governance executables, SPDX 2.3 SBOM,
  third-party licenses, per-file manifest, and SHA-256 checksum.
  Publication remains disabled until the scoped release App is available through
  the approved Infisical/OIDC path.
- Phase 3 now has a metadata-only Infisical policy audit covering exact OIDC
  claims, non-shared least-privilege identities, public-PR isolation, trusted-job
  separation, scoped Secret Syncs, direct-destination exceptions, and rotation
  state. No live mapping, identity, sync, or secret has been created or read.
- Phase 3 also has an identifier-free GitHub policy audit for Fast/Major branch
  protections, Actions trust, security/supply-chain features, deployment review,
  scoped App posture, and runner separation. Authoritative collection and all
  settings changes remain pending scoped App identities and explicit authority.
- Phase 4 now has a deterministic, identifier-free canary plan and evidence
  gate for every approved profile, owner, visibility, stack, release, deployment,
  secret, replay, rollback, and pooled-cost dimension. Candidate selection and
  live execution remain pending private mappings and explicit scoped authority;
  no consumer repository has been selected or changed.

The live snapshot includes private repository names and is deliberately stored
outside this public repository. Only the generator, schemas, aggregate policy,
and secret-free evidence summaries belong here.

Every local and hosted platform gate runs `scripts/public-repository-audit.sh`.
GitHub secret scanning and push protection are also enabled for this public
repository.

## Safety invariants

- Never modify a fork or archived repository.
- Never print, persist, cache, or publish secret values.
- Infisical is the default secret source; direct destination secrets require a
  current machine-readable exception, while synced destinations remain scoped
  and authoritative from Infisical.
- Public and fork PRs receive no secrets, OIDC token, trusted cache writes, or
  private runner access.
- Production requires Max's approval of the exact deployment PR SHA.
- Deployments consume signed immutable artifacts and roll back on failed health
  or soak verification.
- Repeatable decisions are implemented in tested code, not AI prompts.
- Consumers migrate only after representative canaries pass.

## Repository layout

```text
.github/workflows/       reusable GitHub workflows
packages/delivery-ctl/   flama-delivery-ctl
services/bridge/         flama-delivery-bridge
services/governance/     Paperclip-orchestrated read-only governance job
skills/                  Paperclip skills
lifecycles/              Paperclip pipeline templates
routines/                paused Paperclip routine contracts
policies/                scope, GitHub, secrets, Dependabot and cost policy
providers/               deployment adapters
templates/               generated consumer files
schemas/                 machine-readable contracts
scripts/                 deterministic bootstrap and audit tooling
tests/                   policy, contract, workflow and integration tests
docs/                    architecture, operations and recovery runbooks
```

## Phase 0 inventory

The command is read-only in live mode and fails if the observed owner counts do
not match the approved policy:

```bash
./scripts/phase0-inventory.sh \
  --policy policies/repository-scope.json \
  --live \
  --output /protected/local/path/phase0-github.json
```

Do not write a live snapshot into this public checkout.

See [Architecture](docs/architecture.md) and
[Inventory operations](docs/operations/inventory.md). Platform artifact
operations are documented in [Platform releases](docs/operations/platform-release.md),
and the current Paperclip rollout evidence is summarized in
[Phase 2 Paperclip evidence](docs/evidence/phase-2-paperclip.md). The current
canary boundary is summarized in
[Phase 4 canary evidence](docs/evidence/phase-4-canaries.md).
Flama software delivery platform: deterministic lifecycle orchestration, reusable workflows, policies, and evidence
