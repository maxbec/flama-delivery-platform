# Inventory operations

## Purpose

`scripts/phase0-inventory.sh` turns live GitHub metadata into deterministic,
secret-free classification evidence. It records all owned repositories but
allows mutation only for active consumer repositories and the central platform.

Forks, archives, and unknown owners fail closed. The central platform has the
`platform` disposition and does not alter the 64-consumer completion target.

## Requirements

- authenticated GitHub CLI with read access to all three owners;
- `jq`, `base64`, and Bash;
- an output directory outside the public checkout when private repositories are
  present.

## Modes

Fixture mode is offline and used by tests:

```bash
./scripts/phase0-inventory.sh \
  --policy tests/fixtures/inventory/policy.json \
  --fixture tests/fixtures/inventory/repositories.json \
  --observed-at 2026-07-28T12:00:00Z \
  --output /tmp/flama-inventory.json
```

Live mode uses read-only GitHub GraphQL and tree requests. It applies one bounded
retry with jitter only to recognized transient connection, server, or rate-limit
errors. Policy mismatches and malformed data are not retried.

## Evidence handling

The live JSON includes private repository names, branches, commit SHAs, and file
paths. Keep it in protected local evidence storage. Publish only aggregate
counts and a SHA-256 digest. Never attach the raw file to a public workflow,
artifact, PR, issue, release, or job summary.

Before relying on a snapshot, verify:

- owner-specific observed counts equal policy expectations;
- `excludedMutationAllowed` is zero;
- the platform count is one;
- consumer count is 64;
- the file digest matches the recorded evidence;
- the observation timestamp is recent enough for the intended action.

Any mutation command must re-read live fork/archive state immediately before
acting. An inventory snapshot is evidence, not an authorization token.
