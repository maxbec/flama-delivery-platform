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
- `paperclip-foundation --input <company-plan> --output <evidence>` creates or
  reuses the three Flama-owned Paperclip lifecycle pipelines for one exact
  company. It validates the company/controller binding, creates stages and
  enforced transitions from the pinned lifecycle contracts, adds only the
  unreachable administrative-cancellation sentinel required by Paperclip,
  refuses archived companies, open cases, duplicate keys, and drift, and emits
  no company or Paperclip object IDs. Dry-run requests no identity; live use
  accepts the API URL and scoped token only from the process environment and
  writes mode-0600 evidence outside the repository.
- `paperclip-controllers --input <company-plan> --output <evidence>` creates or
  reuses one exact company-local process agent using Paperclip's documented API.
  The agent is zero-budget and immediately paused, cannot create agents, skills,
  or assignments, and refuses configuration drift or board-approval bypasses.
  The external governance controller is deliberately not a Paperclip agent.
- `paperclip-bindings --input <binding-plan> --output <evidence>` verifies one
  fresh, non-fork, non-archived inventory record against the exact Paperclip
  company, active project, project workspace, canonical GitHub remote, and
  default ref before creating or refreshing its private bridge binding. It does
  not create or edit Paperclip projects/workspaces and emits no names or IDs.
- `paperclip-transition-authorize --input <authorization> --output <evidence>`
  lets only the matching company controller authorize one exact, expiring
  external lifecycle edge. It resolves the already-minimized event and active
  repository binding from PostgreSQL, refuses drift, and emits only a digest.
- `paperclip-routines --input <routine-plan> --output <evidence>` creates or
  reuses one exact, company-staggered nightly reconciliation routine through
  Paperclip's documented routine and schedule-trigger APIs. The command verifies
  the active company, exact paused zero-budget controller, and selected active
  project, rejects board-approval bypass and drift, and always creates the
  routine paused. Dry-run requests no identity and live evidence omits object
  identifiers.
- `reconcile --input <company-audit> --output <evidence>` performs a bounded,
  repeatable-read PostgreSQL audit of one company's bindings, inbox/outbox,
  dead letters, and transition authorizations, then verifies recent case and
  transition evidence through a hard GET-only Paperclip client. It never
  replays work or advances a case. Detailed counts and timestamps are written
  create-only at mode `0600`; stdout contains only status, controller, and
  digests. Missing GitHub webhook discovery remains disabled until an
  authoritative private repository selector is supplied by the later scoped
  GitHub App rollout.
- The Flama-owned company controller invokes that same audit only when its sole
  active assignment is the exact scheduled execution issue for the pinned
  routine contract and current Paperclip execution run. It rejects arbitrary,
  manual, concurrent, or drifted work before audit access, stores detailed
  evidence outside the checkout, and posts only status plus an evidence digest
  through Paperclip's documented issue-update API.
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
- `secrets-audit --input <audit>` validates an Infisical-first secret boundary:
  exact short-lived GitHub OIDC claims, project/environment/path scope, public
  PR isolation, trusted-job separation, explicit Secret Sync targets and key
  selection, direct-destination exceptions, rotation dates, and secret-free
  repository variables/generated configuration/Paperclip prompts. Inputs carry
  names and metadata only—never values—and output uses redacted finding codes.
- `github-policy-audit --input <normalized-observation>` compares read-only,
  identifier-free repository metadata with the exact Fast/Major branch profile,
  required checks, merge settings, Actions trust boundary, security features,
  version-tag/release protection, deployment review controls, owner-scoped App
  posture, and three-class runner separation. It returns drift codes and a
  policy digest without repository or installation identifiers.

Every command accepts `--dry-run`; only `bootstrap`, `paperclip-foundation`, `paperclip-controllers`, `paperclip-bindings`, `paperclip-transition-authorize`, `paperclip-routines`,
`reconcile`, `preflight`, `publish-check`, `promote`, `release-evidence`, and
`deploy` currently perform external reads, writes, or execution when dry-run is
absent. `reconcile` is externally read-only and writes only its requested local
evidence file. Inputs are JSON files capped at 10 MiB.
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
