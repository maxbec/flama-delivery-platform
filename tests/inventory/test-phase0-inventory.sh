#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
FIXTURE_DIR="$ROOT_DIR/tests/fixtures/inventory"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

OUTPUT="$TMP_DIR/inventory.json"

"$ROOT_DIR/scripts/phase0-inventory.sh" \
  --policy "$FIXTURE_DIR/policy.json" \
  --fixture "$FIXTURE_DIR/repositories.json" \
  --observed-at "2026-07-28T12:00:00Z" \
  --output "$OUTPUT"

jq -e '
  .schemaVersion == 1 and
  .observedAt == "2026-07-28T12:00:00Z" and
  .summary == {
    total: 8,
    inScope: 5,
    private: 3,
    public: 2,
    forks: 1,
    archived: 1,
    platform: 1,
    mutationAllowed: 6,
    mutationDenied: 2
  } and
  ([.repositories[] | select(.disposition == "in_scope")] | length) == 5 and
  ([.repositories[] | select(.mutationAllowed == true)] | length) == 6 and
  ([.repositories[] | select(.isFork or .isArchived) | select(.mutationAllowed == true)] | length) == 0 and
  ([.repositories[] | has("profile")] | any | not) and
  (.inventoryDigest | test("^sha256:[0-9a-f]{64}$")) and
  ([.repositories[] | .githubRepositoryId | type == "number"] | all) and
  ([.repositories[] | select(.nameWithOwner == "alpha/fast-app")][0] | .githubRepositoryId == 4102) and
  ([.repositories[] | select(.nameWithOwner == "alpha/fast-app")][0] | .stack == ["node"] and .providerIndicators == ["docker"] and .paperclipCompany == "Alpha Paperclip") and
  ([.repositories[] | select(.nameWithOwner == "alpha/major-app")][0] | .stack == ["python"] and .providerIndicators == ["vercel"]) and
  # A Home Assistant add-on repository builds its Dockerfile through Supervisor
  # on the machine that installs it. There is no environment to deploy to, so
  # reading it as a deployment provider forces the two-branch profile onto a
  # repository whose default branch the add-on store serves straight to users.
  ([.repositories[] | select(.nameWithOwner == "alpha/addon-store")][0] | .providerIndicators == []) and
  # A compose file with no Dockerfile in the repository composes images built
  # elsewhere. Nothing here is built and nothing here is deployed, so it names
  # no deployment target either.
  ([.repositories[] | select(.nameWithOwner == "alpha/compose-only")][0] | .providerIndicators == []) and
  # Dockerfiles are not always called exactly that. platzl-finder ships
  # `Dockerfile-webapp` and `Dockerfile-service`, and matching only the bare
  # name dropped a repository that really does build and deploy images.
  ([.repositories[] | select(.nameWithOwner == "alpha/suffixed-dockerfiles")][0] | .providerIndicators == ["docker"]) and
  ([.repositories[] | select(.nameWithOwner == "alpha/platform")][0] | .disposition == "platform" and .mutationAllowed == true) and
  ([.repositories[] | select(.nameWithOwner == "alpha/upstream-fork")][0] | .disposition == "excluded_fork" and .mutationDeniedReason == "fork") and
  ([.repositories[] | select(.nameWithOwner == "alpha/retired")][0] | .disposition == "excluded_archived" and .mutationDeniedReason == "archived")
' "$OUTPUT" >/dev/null

# The digest must be independently recomputable from the published document, so
# a later reader can prove which inventory run authorized a binding.
RECOMPUTED="sha256:$(jq -S -c 'del(.inventoryDigest)' "$OUTPUT" | sha256sum | cut -d' ' -f1)"
PUBLISHED=$(jq -r '.inventoryDigest' "$OUTPUT")
if [[ "$RECOMPUTED" != "$PUBLISHED" ]]; then
  echo "inventory digest is not reproducible from its own document" >&2
  exit 1
fi

# A changed record must change the digest, otherwise it proves nothing.
jq '.repositories[0].defaultBranchHeadSha = "abcdef00000000000000000000000000000000ff"' \
  "$OUTPUT" > "$TMP_DIR/tampered.json"
jq -e '.repositories[0].defaultBranchHeadSha != (input | .repositories[0].defaultBranchHeadSha)' \
  "$TMP_DIR/tampered.json" "$OUTPUT" >/dev/null || {
  echo "tamper fixture did not actually change the record" >&2
  exit 1
}
TAMPERED="sha256:$(jq -S -c 'del(.inventoryDigest)' "$TMP_DIR/tampered.json" | sha256sum | cut -d' ' -f1)"
if [[ "$TAMPERED" == "$PUBLISHED" ]]; then
  echo "inventory digest did not change for a modified repository record" >&2
  exit 1
fi

jq '.owners.alpha.expected.inScope = 6' "$FIXTURE_DIR/policy.json" > "$TMP_DIR/bad-policy.json"
if "$ROOT_DIR/scripts/phase0-inventory.sh" \
  --policy "$TMP_DIR/bad-policy.json" \
  --fixture "$FIXTURE_DIR/repositories.json" \
  --observed-at "2026-07-28T12:00:00Z" \
  --output "$TMP_DIR/should-not-exist.json" >/dev/null 2>&1; then
  echo "inventory unexpectedly accepted a scope-count mismatch" >&2
  exit 1
fi

echo "phase0 inventory tests passed"

LIVE_OUTPUT="$TMP_DIR/live-inventory.json"
PATH="$FIXTURE_DIR/bin:$PATH" \
FLAMA_GH_FIXTURE_DIR="$FIXTURE_DIR" \
  "$ROOT_DIR/scripts/phase0-inventory.sh" \
    --policy "$FIXTURE_DIR/policy.json" \
    --live \
    --observed-at "2026-07-28T12:00:00Z" \
    --output "$LIVE_OUTPUT"

jq -e '
  .source.mode == "live" and
  .summary.inScope == 5 and
  .summary.platform == 1 and
  .summary.mutationDenied == 2 and
  ([.repositories[] | select(.nameWithOwner == "alpha/fast-app")][0] |
    .defaultBranchHeadSha == "1111111111111111111111111111111111111111" and
    .stack == ["node"] and
    .providerIndicators == ["docker"]) and
  ([.repositories[] | select(.isFork or .isArchived) | select(.mutationAllowed)] | length) == 0
' "$LIVE_OUTPUT" >/dev/null

echo "phase0 live serializer regression test passed"
