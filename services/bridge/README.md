# flama-delivery-bridge

The bridge converts authenticated GitHub webhook deliveries into durable,
deduplicated work and then into idempotent Paperclip transition messages. Its
core, database queues, worker boundaries, and configuration are implemented
here. It is not deployed or connected to credentials yet.

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
- Revalidate minimized messages before publication and use
  `github:<delivery-id>:<transition-kind>` as the publisher idempotency key.
- Recover stale claims for replay, bound retries, pause after repeated
  infrastructure failure, and record terminal failures without payload data in
  the dead-letter table.
- Expose liveness separately from database readiness and never return failure
  details.

Apply the numbered migrations in lexical order through a controlled migration
job before starting the service; do not grant the runtime role schema-owner
privileges. `001_inbox_outbox.sql` defines the durable queues and
`002_repository_bindings.sql` defines private runtime bindings without embedding
repository names in this public repository.

Runtime configuration is environment-only after Infisical/OIDC injection. The
parser requires `DATABASE_URL`, `GITHUB_WEBHOOK_SECRET`, `FLAMA_GITHUB_OWNER`,
and `FLAMA_WORKER_ID`; numeric recovery and polling controls are bounded.
Credential-bearing values use a redacting wrapper and configuration failures
emit stable codes without reflecting rejected input.

The `PaperclipPublisher` interface remains an unconnected boundary. Paperclip's
pipeline API is documented and the platform can install canonical lifecycle
pipelines, but publication still requires a private repository-to-case binding
contract and scoped machine identity. Neither is guessed or replaced with a
long-lived token.
