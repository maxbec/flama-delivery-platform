# flama-delivery-ctl

The deterministic JSON interface used by Paperclip and platform automation.
It writes one JSON object to stdout on a completed command and a redacted error
code to stderr for invocation failures. It never reflects unknown arguments or
input values in error output.

Implemented commands:

- `inventory --input <inventory>` rechecks scope/count invariants and emits
  aggregate counts plus a full-snapshot digest without repository names.
- `bootstrap --input <bootstrap-plan> --output <checkout>` requires an exact,
  clean local checkout at the recorded `origin/main` or `origin/dev` SHA. It
  denies forks, archives, unknown owners, stale source state, and inconsistent
  delivery/Paperclip metadata. Generated files are drift-protected;
  repository-owned scaffolds are create-once and never overwritten.
- `validate --schema <name> --input <file>` validates a supported platform
  schema with strict AJV rules.
- `classify --input <inventory>` validates a Phase 0 inventory and recommends
  Fast or Major only for mutable, in-scope consumers.
- `render --dry-run --input <render-plan> --output <checkout>` plans pinned
  Fast/Major Branch Guard, Policy, Final, and Deploy callers, staggered Dependabot policy, Release Please
  configuration, delivery `CODEOWNERS`, the platform lock, and secret-free
  Paperclip webhook routing metadata. Direct writes are denied; `bootstrap`
  applies the plan only after repository-scope and source-state checks.
- `deployment-pr --input <evidence>` validates Max's latest review against the
  exact PR head and allows only `.deploy/production.yaml` to change.
- `preflight --input <run-plan> --output <evidence>` verifies the clean exact
  Git SHA and executes only `./scripts/delivery buildable` followed by
  `./scripts/delivery affected`. Child output is never echoed or persisted;
  evidence contains only byte counts, timings, exit codes, and SHA-256 digests.
  The result is unsigned and must be certified by a separate Delivery
  Controller for the same SHA.
- `publish-check --input <controller-evidence>` validates the canonical signed
  evidence digest, exact command sequence, owner/controller binding, and
  fork/archive scope before planning or publishing `Paperclip Preflight` for the
  exact SHA. Publication accepts only a short-lived `ghs_` installation token
  from the process environment, proves it is scoped to exactly one repository,
  and never emits the token or GitHub error bodies.
- `promote --input <promotion-plan> --output <evidence>` creates or reuses the
  Major-profile `dev → main` pull request only when both protected branches
  match their recorded SHAs, `dev` is strictly ahead and not behind, and the
  exact controller-app `Paperclip Integration Smoke` check passed. Live use
  requires a short-lived installation token scoped to one repository; dry-run
  requests no identity.
- `release-evidence --input <release-plan> --output <evidence>` recomputes local
  archive, checksum, and SBOM digests; requires immutable repository/release
  state and an exact tag-to-source binding; then cryptographically verifies the
  release and every asset through GitHub CLI. It accepts only the short-lived
  GitHub App installation token from the process environment and suppresses all
  verifier/API bodies.
- `deploy --format yaml --input <manifest> --adapter <module> --output <file>`
  runs the provider-neutral deployment/soak/rollback state machine. Dry-run
  validates and plans without importing the adapter or requesting identity.
- `secrets-audit --input <audit>` validates and audits an Infisical-first secret
  configuration using redacted finding codes.

Every command accepts `--dry-run`; only `bootstrap`, `preflight`,
`publish-check`, `promote`, `release-evidence`, and `deploy` currently perform
writes or execution when dry-run is absent. Inputs are JSON files capped at 10 MiB.
Secret values are not valid fields in the secret-audit schema.

Development:

```bash
pnpm typecheck
pnpm test:unit
pnpm build
node dist/packages/delivery-ctl/src/main.js --version
bash tests/release/test-cli-bundle.sh
```

Release builds compile strictly with TypeScript first, then bundle that ESM with
`@vercel/ncc`. This avoids ncc's current TypeScript 7 loader incompatibility
without skipping typechecking or shipping runtime dependencies.
