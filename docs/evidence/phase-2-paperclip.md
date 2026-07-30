# Phase 2 Paperclip foundation evidence

Status: in progress

Raw responses, credentials, company and object identifiers, timestamps, and
live inventory measurements remain in protected local evidence storage. This
public summary contains only qualitative outcomes and reproducible controls.

Implemented and verified:

- The complete `flama-paperclip-delivery` skill bundle was imported from one
  pinned source revision, content-verified, and assigned across the eligible
  live agent scope without replacing external user skills or changing agents
  awaiting approval.
- `flama-delivery-ctl paperclip-foundation` validates an exact
  company/controller binding and derives deterministic pipeline stages and
  enforced transition edges from the versioned lifecycle contracts.
- Dry-run requires no identity. Live mode accepts the Paperclip endpoint and
  scoped credential only through the process environment, suppresses response
  bodies, bounds response size and latency, and emits no company or Paperclip
  object identifiers.
- The installer refuses archived companies, duplicate managed keys, open cases,
  and any drift in names, descriptions, stages, transition labels, or
  enforcement state. An interrupted exact creation can resume only while its
  transition set is still empty.
- Paperclip requires both successful and cancellation terminal stage kinds.
  Each installed pipeline therefore has one reserved administrative
  cancellation sentinel with no normal transition edge; the authoritative
  lifecycle graph remains unchanged.
- The rollout used dry-run across the approved scope, then one live canary, an
  idempotent reuse check, and only then the remaining approved scope. Final
  readback through the same fail-closed installer matched every managed stage
  and enforced edge.
- Temporary inputs containing private identifiers were deleted after use.
  Retained evidence is mode `0600`, identifier-free, and outside the public
  checkout.
- The approved topology uses three company-local, zero-budget process agents
  and a Paperclip-orchestrated read-only governance job. Two company controllers are
  verified paused; the remaining native hire request awaits its company's human
  board approval and has not been bypassed.
- `paperclip-bindings` now provides the fail-closed project/workspace binding
  boundary. It verifies fresh inventory, company/project/workspace ownership,
  canonical GitHub remote and default ref before inserting or refreshing a
  private bridge binding, while emitting no repository or object identifiers.
- The bridge publisher now requires an exact, expiring controller authorization
  tied to the minimized-event digest, live repository-binding digest, company,
  case, pipeline, and a database-constrained lifecycle edge. It can only fire
  one exact timestamped-HMAC Paperclip routine webhook and holds no Paperclip
  account, board token, agent API key, or case API access. The native company
  controller revalidates the authorization and live company/pipeline/stage/
  version, performs the documented transition under its current Paperclip run
  identity, and uses paginated event history for crash-safe replay.
- GitHub evidence minimization now retains the head/base branch and trusted
  workflow/check identity fields needed for deterministic routing, while
  continuing to discard bodies, sender records, and unknown fields.
- The complete bridge runtime is bundled deterministically for Node.js 26 with
  its third-party notices. PostgreSQL 18 integration tests cover migration
  replay, exact authorization resolution, publication recording, and rejection
  after repository-binding drift.
- The global governance controller is a deterministic Node.js 26 executable
  orchestrated by Paperclip. It accepts fresh, digest-bound attestations
  produced under native company-controller runs instead of polling Paperclip or
  holding board credentials. Its only network transport is GET-only GitHub,
  with fixed company/owner pairings, distinct owner-scoped App identities,
  bounded metadata pagination, and private mode-0600 evidence while exposing
  only an evidence digest to ordinary logs.
- Governance unit tests cover cross-company substitution, stale or malformed
  Paperclip-attestation rejection, shared GitHub-credential rejection,
  response-body suppression, exact-attempt GitHub job reads, identifier-free
  aggregation, timestamp validation, and private evidence permissions. The
  bundle is included in deterministic platform artifacts.
- A versioned nightly reconciliation routine contract uses per-company
  staggered schedules, coalesces overlapping runs, skips missed schedules, and
  starts paused. The deterministic installer verifies the exact company,
  approved paused controller, and explicitly selected active project, then uses
  only Paperclip's documented routine and schedule-trigger APIs. It resumes an
  exact interrupted creation but rejects duplicates, activation, or drift.
- The `reconcile` command now provides the routine's executable read-only audit
  boundary. It uses parameterized aggregate queries inside a bounded
  repeatable-read PostgreSQL transaction forced read-only, verifies recent
  authorization/case transition evidence through a GET-only Paperclip client,
  fails closed on oversized scans, and writes only mode-0600 metadata evidence.
  Ordinary output omits live identifiers, counts, and timestamps.
- The company controller now recognizes only the exact schedule-created routine
  issue bound to its current Paperclip execution run. It re-verifies the active
  routine, sole enabled trigger, and linked routine-run record before invoking
  the fixed read-only audit. Arbitrary assignments and manual or drifted runs
  fail closed. Detailed evidence remains create-only mode `0600` outside the
  checkout; the issue receives only the audit status and evidence digest.
- A second versioned routine contract accepts one minimized bridge delivery
  through Paperclip's released public routine-trigger endpoint using
  `hmac_sha256`, a five-minute replay window, durable idempotency, and
  `always_enqueue`. The resulting issue contains no free-form webhook body; the
  native controller reads the exact stored trigger payload, validates the
  linked routine run, and emits only the evidence digest after transition.
- A separate deterministic installer now creates that second routine paused and
  creates only its exact `hmac_sha256` trigger. Paperclip's one-time URL and
  secret are held in memory while both exact bridge keys are upserted to one
  explicit Infisical project/environment/path. Reruns request
  `viewSecretValue=false` and compare only trigger-bound receipt metadata. An
  exact receipt is reused; a missing or partial two-secret receipt rotates once
  and repairs both entries, while a due rotation interval replaces both even
  when their receipts are exact. Output and evidence contain no identifiers,
  paths, URLs, timestamps, or values.
- Because released Paperclip necessarily retains the generated verifier copy,
  live trigger creation also requires a current `provider_native_secret`
  exception. The installer validates and digests that approval record before
  mutation. Infisical remains the bridge's authoritative runtime source, and
  routine activation remains separately gated.
- The immutable Node.js 26 platform archive now includes the company-controller
  executable. Controller provisioning points to that pinned release entrypoint
  instead of a mutable source checkout or Paperclip package modification. Its
  installer can migrate only the exact paused, platform-managed topology-v1
  source entrypoint; any other agent configuration drift still fails closed.
- The same native controller run now reads only its own company, identity, and
  managed lifecycle metadata, emits a digest-bound governance attestation beside
  the reconciliation evidence in the protected mode-0600 evidence directory,
  and returns only its digest. This replaces the rejected external Paperclip
  polling/account pattern without changing the released Paperclip package.
- A documented-CLI re-audit confirmed exact lifecycle graphs and desired skill
  assignments across the eligible scope. It also found that the live controller
  records still use the exact legacy source entrypoint. Their least-privilege
  permissions, zero budgets, and existing executables remain intact, but the
  immutable-entrypoint migration has not been applied. The temporary operator
  token was revoked and removed after this read-only audit.

Still pending:

- One company controller remains behind Paperclip's native board approval.
- The approved controllers still require the installer's fail-closed migration
  from the exact legacy source entrypoint to the immutable release entrypoint.
- Selecting each repository's project/workspace mapping and applying private
  bindings remains pending; the command intentionally does not guess mappings.
- Live bridge deployment, routine-trigger secret injection, and controller
  authorization writes remain pending explicit deployment authority, Infisical
  mapping, and the private repository/case mappings. The runtime does not infer
  those mappings. No Paperclip reader or machine account is required.
- Live governance collection remains pending three owner-scoped read-only
  GitHub App identities, native attestations from all three company controllers,
  and a private repository/profile selector file. No Paperclip human account or
  board token is required. Cache-hit coverage stays explicitly unavailable
  until generated workflows emit the bounded signal required for an actual rate.
- Routine application remains pending the authoritative project selection, the
  remaining controller's native board approval, the exact Infisical mapping,
  and approval of the Paperclip verifier-copy exception. Activation remains
  gated on the deployed bridge, private bindings, successful receipt capture,
  and an explicit production authorization.
- Authoritative GitHub missed-event discovery remains pending the later scoped
  GitHub App identities and private repository selectors. The current audit
  intentionally does not guess either input or replay dead letters.
- Consumer repository migration, GitHub App installation, and production
  deployment remain separate later-phase work with their own canaries and
  approvals.

This evidence authorizes neither production deployment nor secret publication.
