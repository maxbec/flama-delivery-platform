# Failure and recovery policy

Plan section 20 states failure handling as policy. `flama-delivery-ctl
failure-policy` is the single deterministic decision point for those rules, so no
controller, workflow, or agent re-derives them.

```bash
flama-delivery-ctl failure-policy --dry-run --input /protected/evidence/failure.json
```

## Input is metadata only

A failure observation carries a stage, a classification, a `sha256:` digest of the
normalized failure fingerprint, the attempt number, how many recent failures share
that signature, and optionally the signature of an already-open incident. A failure
message, log excerpt, path, or command line is never accepted, and the decision
output contains none of them.

## Decisions

| Classification | Retry | Follow-up |
| --- | --- | --- |
| `deterministic` | Never | Repair task |
| `flaky_test` | Once, jittered | Stabilization task, always recorded |
| `transient_infrastructure` | Once, jittered | Repair task once the retry is spent |
| `deployment_health` | Never — rollback already ran once | Repair task |
| `secret_exposure` | Never | Security incident, credential rotation |
| `blocked_destructive_migration` | Never | Repair task |
| `pooled_budget_critical` | Never | Repair task |
| `platform_integrity` | Never | Repair task, incident |

Exactly one retry is ever permitted, and only for a recognized transient cause or
a flake. A second attempt of the same cause is denied, which is what stops a
repeated redeploy or a retry loop.

The retry delay is jittered within a 5–35 second window so simultaneous failures
do not resynchronize on the next attempt. A dry run uses the midpoint of that
window instead of a random draw, so planning output is reproducible.

## Incidents and the release path

Two or more recent failures sharing one signature is repeated infrastructure
failure, not a blip. That opens an incident and pauses the release path. So does a
confirmed secret exposure or a platform-integrity failure.

An incident whose signature already has one open is reported `deduplicated`
rather than opened again, and it does not notify the owner a second time. The
release path stays paused either way: any incident disposition other than `none`
pauses it, and the result schema enforces that.

## Owner notification

The owner is notified only for the conditions plan section 20 lists: deployment
health failure, secret exposure, blocked destructive migration, critical pooled
budget, and platform integrity — plus a newly opened incident. Deterministic
build failures and flakes never notify; they create tasks.

## Secret exposure fails closed

A confirmed exposure denies any retry, opens a security incident, pauses the
release path, and sets `rotateCredential`. The result schema enforces all four
together, so a decision cannot claim exposure handling without them.
