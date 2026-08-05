# Pooled compute budget caching

Plan section 8 governs consumption across all three GitHub owners as one pooled
`flama-ci-budget`. Caching is the largest lever, and plan section 16 constrains
where it may be applied: the untrusted public and fork lane must never perform a
trusted cache write.

## Lane split

The platform's own CI restores the pnpm store in every lane and saves it only
from a protected default-branch push:

- `actions/cache/restore` runs unconditionally, so a pull request benefits from
  whatever the trusted lane already published.
- `actions/cache/save` is guarded by `github.event_name == 'push'`, so an
  untrusted pull request can never publish a store that the trusted lane later
  restores. Save is additionally skipped on a hit, because rewriting an
  identical key is wasted budget.
- Both halves are pinned to the same full commit SHA. The combined
  `actions/cache` action is rejected by
  `tests/workflows/test-platform-ci.sh`, because a single action both restores
  and saves and would reintroduce the untrusted write.

`tests/workflows/test-platform-ci.sh` fails closed if the save guard is removed
or the split is collapsed.

## Key composition

The cache key carries every input plan section 8 requires:

```text
flama-pnpm-trusted-<runner.os>-<runner.arch>-<hash of .nvmrc>-<hash of pnpm-lock.yaml>
```

- `flama-pnpm-trusted` is the trust-boundary namespace. Only trusted-lane writes
  ever occupy it.
- `runner.os` and `runner.arch` cover the OS input.
- `.nvmrc` covers the runtime input.
- `pnpm-lock.yaml` covers the lockfile input.

A cache miss never changes correctness: installation is always
`pnpm install --frozen-lockfile`, which resolves from the lockfile whether or
not the store was restored.

## Cache-hit reporting

The Governance Controller reports the pooled cache-hit rate from a marker step
rather than from logs or artifacts. The step

```yaml
- name: Record dependency cache hit
  if: ${{ steps.dependency-cache.outputs.cache-hit == 'true' }}
```

runs only on a hit, so the jobs API shows it as `success` on a hit and `skipped`
on a miss. Governance reads step names and conclusions only, which keeps the
aggregation metadata-only and identifier-free.

Coverage is honest about what it has seen:

- `reported` with a rate, once at least one sampled run carries the marker;
- `not_emitted` while no sampled run carries it. Absence is never counted as a
  miss.
- A marker conclusion that is neither `success` nor `skipped`, or a marker that
  is both within a single run, fails the collection closed rather than guessing.

Consumer repositories install their own dependencies through the
repository-owned `./scripts/delivery` entrypoint, so their caches and their
marker step arrive with the generated callers in the migration waves. Until
then, governance correctly reports consumer cache-hit coverage as
`not_emitted`.
