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
  and an external read-only governance service. Two company controllers are
  verified paused; the remaining native hire request awaits its company's human
  board approval and has not been bypassed.
- `paperclip-bindings` now provides the fail-closed project/workspace binding
  boundary. It verifies fresh inventory, company/project/workspace ownership,
  canonical GitHub remote and default ref before inserting or refreshing a
  private bridge binding, while emitting no repository or object identifiers.
- The bridge publisher now requires an exact, expiring controller authorization
  tied to the minimized-event digest, live repository-binding digest, company,
  case, pipeline, and a database-constrained lifecycle edge. It validates the
  live Paperclip company/pipeline/stage/version before and after the documented
  transition call and uses paginated event history for crash-safe replay.
- GitHub evidence minimization now retains the head/base branch and trusted
  workflow/check identity fields needed for deterministic routing, while
  continuing to discard bodies, sender records, and unknown fields.
- The complete bridge runtime is bundled deterministically for Node.js 26 with
  its third-party notices. PostgreSQL 18 integration tests cover migration
  replay, exact authorization resolution, publication recording, and rejection
  after repository-binding drift.
- The global governance controller is an external Node.js 26 executable, not a
  Paperclip agent. It enforces fixed company/owner pairings, distinct read-only
  credentials per scope, GET-only Paperclip and GitHub transports, bounded
  metadata pagination, and private mode-0600 detailed evidence while exposing
  only an evidence digest to ordinary logs.
- Governance unit tests cover cross-company substitution, shared-credential
  rejection, response-body suppression, exact-attempt GitHub job reads,
  identifier-free aggregation, timestamp validation, and private evidence
  permissions. The bundle is included in deterministic platform artifacts.
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

Still pending:

- One company controller remains behind Paperclip's native board approval.
- Selecting each repository's project/workspace mapping and applying private
  bindings remains pending; the command intentionally does not guess mappings.
- Live bridge deployment, scoped machine identity injection, and controller
  authorization writes remain pending explicit deployment authority and the
  private repository/case mappings. The runtime does not infer those mappings.
- Live governance collection remains pending the six separately scoped
  read-only identities and a private repository/profile selector file. Cache-hit
  coverage stays explicitly unavailable until generated workflows emit the
  bounded signal required for an actual rate.
- Routine application remains pending the authoritative project selection and
  the remaining controller's native board approval. Even after application,
  activation remains gated on the deployed bridge, private bindings, and exact
  controller dispatch wiring for the managed routine issue.
- Authoritative GitHub missed-event discovery remains pending the later scoped
  GitHub App identities and private repository selectors. The current audit
  intentionally does not guess either input or replay dead letters.
- Consumer repository migration, GitHub App installation, and production
  deployment remain separate later-phase work with their own canaries and
  approvals.

This evidence authorizes neither production deployment nor secret publication.
