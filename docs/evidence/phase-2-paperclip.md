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

Still pending:

- Paperclip agents are company-scoped. Deploying the controller runtime needs
  an explicit choice between company-local delivery controllers with an
  external read-only governance aggregator and a different documented model.
- The bridge publisher remains disconnected until a private
  repository-to-case binding contract and scoped machine identity exist.
- Consumer repository migration, GitHub App installation, and production
  deployment remain separate later-phase work with their own canaries and
  approvals.

This evidence authorizes neither production deployment nor secret publication.
