# Operator-initiated rollback

`flama-delivery-ctl rollback` restores a previously deployed immutable artifact
after a deployment has already completed. It is separate from the automatic
in-deployment rollback that `flama-delivery-ctl deploy` performs when immediate
or soak verification fails; that path is bounded to one attempt inside the
deployment run and needs no operator action.

Plan a rollback without an adapter, an identity, or any provider contact:

```bash
flama-delivery-ctl rollback \
  --dry-run \
  --input /protected/evidence/rollback.json
```

A plan reports only the restored digest, the superseded digest, the provider,
and whether the rollback is a drill. It carries no timing, no provider
evidence, and no attempt, because nothing was contacted.

## Fail-closed preconditions

The command refuses, before reaching the provider, when:

- the target digest is not a full `sha256:` digest, equals the currently
  deployed digest, or the target URI is a mutable reference such as `:latest`;
- `verification.expectedVersion` is not exactly the target version, so a
  restore can never be verified against the version it replaced;
- the soak window is shorter than ten minutes;
- the recorded migration is not rollback compatible, which is the expand/contract
  guarantee that a destructive schema change cannot be hidden behind a restore;
- the rollback is not a drill and carries no incident reference; or
- the loaded adapter belongs to a different provider than the input names.

## Execution

```bash
flama-delivery-ctl rollback \
  --input /protected/evidence/rollback.json \
  --adapter .flama/provider.cjs \
  --output /protected/evidence/rollback-result.json
```

Execution restores the target artifact exactly once, then verifies health, the
deployed version, and `./scripts/delivery smoke` immediately and at every soak
interval. There is never a second restore attempt: a failed provider call, an
unhealthy restore, a version mismatch, a failed smoke check, a crashed probe,
or unusable provider evidence all end as `failed` with a reason code and
exactly one recorded attempt.

Only a fully verified restore reports `restored`, and only then does the result
carry provider evidence.

## Drills

Recovery drills set `authorization.drill` to `true` and omit the incident
reference. The drill flag is preserved in the result so drill evidence can
never be mistaken for a production incident restore. Every other precondition
still applies to a drill.

## Evidence safety

Result evidence is identifier-minimized: it contains digests, not artifact
URIs, registry hosts, or incident references. The deterministic CLI bundle test
asserts that a bundled rollback plan emits neither a registry reference nor an
incident identifier.
