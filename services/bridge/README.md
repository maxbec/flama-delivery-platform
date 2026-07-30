# flama-delivery-bridge

The bridge converts authenticated GitHub webhook deliveries into durable,
deduplicated work and then fires one controller-authorized, HMAC-protected
Paperclip routine. The native Delivery Controller performs the transition
inside Paperclip under its current run identity.
Its HTTP service, database queues, authorization boundary, publisher, recovery
workers, and deterministic Node.js 26 bundle are implemented here. It is not
deployed or connected to credentials yet.

Trust and durability invariants:

- Verify the `sha256` webhook HMAC over the original request bytes before JSON
  parsing or persistence.
- Reject repository owners other than the one configured for that bridge
  instance.
- Require a current database binding at intake and again before transition
  creation; inactive, unknown, fork, and archived repositories fail closed.
- Minimize every accepted event before persistence. Retain only repository,
  exact-SHA, external ID, lifecycle state, and safe HTTPS evidence; discard PR
  bodies, review bodies, sender records, and unknown fields.
- Never persist or log the webhook signature or webhook secret.
- Deduplicate on GitHub's delivery ID.
- Claim inbox and outbox work with `FOR UPDATE SKIP LOCKED`.
- Complete inbox work and create its transition in one transaction.
- Retain branch names, workflow/check names, and check-run app slugs needed to
  distinguish trusted evidence, while continuing to discard free-form bodies.
- Revalidate minimized messages before publication and use
  `github:<delivery-id>:<transition-kind>` as the private publisher idempotency
  key.
- Require a live controller authorization for the exact minimized-event digest,
  repository binding digest, company, case, pipeline, and permitted lifecycle
  edge. A webhook or repository binding alone cannot select a case.
- Call only the released public routine-trigger endpoint, bound to one exact
  trigger URL, with a timestamped HMAC and idempotency key. The bridge has no
  Paperclip account, board token, agent API key, or case API access.
- Let the native company Delivery Controller revalidate company, pipeline,
  stage, terminal state, optimistic version, event digest, repository binding,
  and exact transition authorization before and after the case transition.
- Put only a digest of the idempotency key in Paperclip's transition reason.
  After a crash, scan paginated case events for that exact reason and edge
  before considering the transition already applied.
- Recover stale claims for replay, bound retries, pause after repeated
  infrastructure failure, and record terminal failures without payload data in
  the dead-letter table.
- Expose liveness separately from database readiness and never return failure
  details.

Apply the numbered migrations in lexical order through a controlled migration
job before starting the service; do not grant the runtime role schema-owner
privileges. `001_inbox_outbox.sql` defines the durable queues,
`002_repository_bindings.sql` and `003_binding_identity.sql` define private
runtime bindings without embedding repository names in this public repository,
`004_external_transition_authorizations.sql` constrains the exact external
lifecycle edges a company controller may authorize, and
`005_reconciliation_indexes.sql` adds company-scoped read paths for the bounded
nightly audit without modifying queue data.

Runtime configuration is environment-only after Infisical/OIDC injection. The
runtime requires `DATABASE_URL`, `GITHUB_WEBHOOK_SECRET`,
`FLAMA_GITHUB_OWNER`, `FLAMA_WORKER_ID`, `PAPERCLIP_ROUTINE_WEBHOOK_URL`, and
`PAPERCLIP_ROUTINE_WEBHOOK_SECRET`; numeric recovery and polling controls are
bounded. The routine URL must target exactly
`/api/routine-triggers/public/<id>/fire`. Credential-bearing values use a
redacting wrapper and configuration failures emit stable codes without
reflecting rejected input.
Run `bin/bridge/index.js` from the signed platform artifact under a supervisor;
the process emits only stable status/reason codes and stops after two
consecutive infrastructure failures.

`flama-delivery-ctl paperclip-bindings` now verifies a fresh authoritative
inventory record against the exact Paperclip company, active project, project
workspace, canonical GitHub remote, and default ref before creating or safely
refreshing a private database binding. It does not create or rewrite Paperclip
projects/workspaces and never emits their IDs or repository names.

The publisher is wired in the packaged runtime but remains fail-closed until a
company controller writes an exact, expiring authorization and the matching
Paperclip routine-trigger secret is injected from Infisical. The outbox is
marked delivered only after Paperclip durably accepts the idempotent routine
run; the authorization is marked published only after the native controller
proves the exact case transition. Repository/project/workspace binding alone is
deliberately insufficient to guess which case an external event may advance.
The controller authorization writer and bridge runtime roles remain distinct:
the runtime may validate an authorization but cannot mint or complete one.
