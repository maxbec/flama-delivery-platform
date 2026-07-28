# Phase 1 runtime foundation evidence

Status: in progress

Approved runtime baseline:

- Node.js 26
- TypeScript 7 and pnpm workspaces
- Fastify and AJV
- PostgreSQL 18 durable inbox/outbox
- Vitest and Testcontainers

Implemented evidence as of 2026-07-28:

- Strict AJV compilation found and corrected missing object types in two
  conditional schemas.
- `validate`, `inventory`, `classify`, `bootstrap`, `render`, `preflight`,
  `publish-check`, `promote`, `release-evidence`, `deployment-pr`, `deploy`, and
  `secrets-audit` have structured, redacted behavior.
- `publish-check` recomputes the canonical signed preflight digest, binds the
  exact SHA to the owner-matched Delivery Controller, proves the short-lived
  GitHub App token is scoped to one repository, and idempotently creates or
  reuses the matching app-authored check without exposing API error bodies.
- `promote` proves a one-repository GitHub App scope, protected exact `dev` and
  `main` SHAs, strict ahead/not-behind ancestry, and the exact successful
  controller-app integration check before idempotently creating or reusing a
  Major-profile promotion PR. Its evidence omits repository and app identity.
- `release-evidence` binds three locally recomputed digests (archive, checksum,
  and SBOM) to one published immutable release, the exact source SHA, and
  GitHub's cryptographically verified release and per-asset attestations. Its
  output omits repository names and local paths, and GitHub response bodies are
  suppressed.
- Reusable release packaging runs `buildable` without repeating `full`, then
  passes exactly three normalized files into a separate attestation job. The
  job that executes repository code has no OIDC or attestation permission; the
  identity-capable job never checks out or executes repository code and
  re-hashes all transferred files before signing.
- Bootstrap denies forks, archives, unknown owners, dirty worktrees, mismatched
  GitHub remotes, and checkouts that differ from the recorded `origin/main` or
  `origin/dev` SHA. Its evidence omits repository and Paperclip binding names.
- Preflight verifies a clean exact Git SHA, executes only the fixed `buildable`
  and `affected` entrypoints, never echoes child output, and produces unsigned
  digest-only evidence for a separate controller to certify.
- GitHub webhook HMAC verification runs over raw bytes before parsing.
- Bridge instances enforce one of `maxbec`, `navigaite`, or `edilio` as their
  allowed owner.
- The bridge discards PR/review bodies, sender records, and unknown webhook
  fields before persistence, then revalidates the minimized event before
  publication.
- Repository scope is checked against private database bindings at intake and
  processing, so forks, archives, inactive, unknown, and unbound repositories
  fail closed without publishing their names here.
- PostgreSQL integration tests prove delivery deduplication, competing-worker
  exclusion, atomic transition creation, idempotent outbox publication, stale
  claim replay, bounded retries, binding enforcement, and inbox/outbox
  dead-lettering.
- Versioned project, feature/fix, and release/deployment lifecycle contracts;
  three company controller contracts; the read-only governance contract; and
  the validated shared Paperclip skill are included in the platform archive.
- The standalone renderer is planning-only. Scope-checked bootstrap applies
  pinned workflow callers, staggered Dependabot policy, Release Please config,
  delivery `CODEOWNERS`, the platform lock, and secret-free webhook routing
  metadata. It refuses generated-file drift and creates missing
  repository-owned scaffolds without overwriting existing content.
- Branch Guard, policy, final, and release-evidence reusable workflows use
  full-SHA action pins and pass actionlint v1.7.12. Final Gate runs before merge
  on the PR-to-`main` boundary; Policy Gate validates the contract and exact
  app-authored preflight check without rerunning application tests.
- Deployment-only PRs are classified from the exact base/head diff and validate
  only `.deploy/production.yaml`; all other main-boundary changes fail closed
  into `./scripts/delivery full`.
- The production deploy workflow revalidates the merged event, exact platform,
  head and merge SHAs, Max's latest review, manifest-only diff, OIDC reusable
  workflow claim, and strict YAML manifest before any provider mutation.
- The provider-neutral state machine verifies health, version, and smoke through
  a 600-second minimum soak and rolls back at most once.
- `@vercel/ncc` packages the compiled TypeScript output into a self-contained
  CLI. Two independent builds are byte-identical and a bundled regression proves
  runtime loading of the repository provider adapter.
- The deterministic platform archive includes SPDX 2.3, third-party licenses,
  per-file SHA-256 digests, a schema-validated release manifest, and an external
  checksum; two complete archives compare byte-for-byte.
- The mandatory public-repository audit rejects credential signatures, literal
  secrets, sensitive credential files, and private inventory. GitHub secret
  scanning and push protection are enabled with zero open alerts at this
  checkpoint.
- Node.js 26 strict typechecking, 99 unit tests, and 8 PostgreSQL 18 integration
  tests pass locally. The latest prior hosted Platform CI run `30406354053`
  passed for exact signed commit
  `9a235e12afdf4a45bcbfb23666a8dbc0309d6939`.

This is implementation evidence, not deployment or production authorization.
