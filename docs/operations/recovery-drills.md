# Recovery drills

Plan section 20 requires rollback and recovery drills to run from deterministic
scripts, and plan section 21 phase 6 requires them to have been performed before
the programme is complete.

A drill exercises real recovery. The rollback drill restores an actual deployment;
the replay drill writes to an actual bridge inbox. Neither runs against fakes,
because a drill against fakes proves only that the fakes work. Both therefore
refuse to run unless explicitly authorized.

## What CI verifies, and what it does not

CI runs `tests/drills/test-drills.sh`, which proves each drill **refuses** every
unauthorized or under-specified invocation and carries no credential of its own.
CI does not run the drills: they need infrastructure that does not exist in a
public runner, and a green CI run is not drill evidence.

Each refusal test asserts the reason, not merely that the script exited non-zero.
Otherwise an unrelated precondition could satisfy the assertion and the guard
under test could be deleted without failing anything.

## Rollback drill

```bash
FLAMA_DRILL_CONFIRM=yes \
FLAMA_DRILL_MANIFEST=/protected/evidence/rollback-drill.json \
FLAMA_DRILL_ADAPTER=.flama/provider.cjs \
FLAMA_DRILL_WORKDIR=/path/to/consumer/checkout \
bash scripts/drill-rollback.sh
```

Refusals, each with its reason:

- `FLAMA_DRILL_CONFIRM` is not exactly `yes` — a drill restores a real deployment.
- The manifest, adapter, or working directory is missing or not a file/directory.
- The platform is not built, so the CLI entrypoint is absent.
- **The input is not marked as a drill.** `authorization.drill` must be `true`.
  Running the drill against a production incident rollback input would produce
  drill evidence for a real restore, so this is refused outright.

The drill asserts the recovery guarantees rather than that the command ran:
`status: "restored"`, exactly one attempt, `drill: true`, and at least two
verification checks. If the restore fails it reports the failure and, when the
evidence shows it, confirms that exactly one attempt was made — the guarantee that
matters most in a failed restore.

Expect the drill to take at least the soak window, because verification is real.

## Event-replay drill

```bash
DATABASE_URL=postgres://... \
FLAMA_DRILL_CONFIRM=yes \
node scripts/drill-event-replay.mjs
```

The drill uses a marked `flama-replay-drill-<uuid>` delivery id so it can never be
mistaken for a real delivery, and asserts the durability guarantees the bridge
must hold:

- a new delivery is accepted;
- a redelivered delivery is **deduplicated**, however many times GitHub retries it;
- the queued delivery is claimable exactly once; and
- stale-claim recovery reports a bounded, countable outcome, so a worker that dies
  mid-claim returns the event to the queue rather than stranding it.

It refuses without `DATABASE_URL` and without confirmation, and never invents an
endpoint or a credential.

## Recording drill evidence

Drill output belongs in protected mode-`0600` storage outside this public
repository, alongside the other live evidence. A drill has not been performed
until its evidence exists; no phase status in the progress checkpoint may claim
otherwise.
