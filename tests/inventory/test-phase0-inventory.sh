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
    total: 5,
    inScope: 2,
    private: 1,
    public: 1,
    forks: 1,
    archived: 1,
    platform: 1,
    mutationAllowed: 3,
    mutationDenied: 2
  } and
  ([.repositories[] | select(.disposition == "in_scope")] | length) == 2 and
  ([.repositories[] | select(.mutationAllowed == true)] | length) == 3 and
  ([.repositories[] | select(.isFork or .isArchived) | select(.mutationAllowed == true)] | length) == 0 and
  ([.repositories[] | select(.nameWithOwner == "alpha/fast-app")][0] | .profile == "fast" and .stack == ["node"] and .providerIndicators == ["docker"] and .paperclipCompany == "Alpha Paperclip") and
  ([.repositories[] | select(.nameWithOwner == "alpha/major-app")][0] | .profile == "major" and .stack == ["python"] and .providerIndicators == ["vercel"]) and
  ([.repositories[] | select(.nameWithOwner == "alpha/platform")][0] | .disposition == "platform" and .mutationAllowed == true and .profile == null) and
  ([.repositories[] | select(.nameWithOwner == "alpha/upstream-fork")][0] | .disposition == "excluded_fork" and .mutationDeniedReason == "fork") and
  ([.repositories[] | select(.nameWithOwner == "alpha/retired")][0] | .disposition == "excluded_archived" and .mutationDeniedReason == "archived")
' "$OUTPUT" >/dev/null

jq '.owners.alpha.expected.inScope = 3' "$FIXTURE_DIR/policy.json" > "$TMP_DIR/bad-policy.json"
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
  .summary.inScope == 2 and
  .summary.platform == 1 and
  .summary.mutationDenied == 2 and
  ([.repositories[] | select(.nameWithOwner == "alpha/fast-app")][0] |
    .defaultBranchHeadSha == "1111111111111111111111111111111111111111" and
    .stack == ["node"] and
    .providerIndicators == ["docker"]) and
  ([.repositories[] | select(.isFork or .isArchived) | select(.mutationAllowed)] | length) == 0
' "$LIVE_OUTPUT" >/dev/null

echo "phase0 live serializer regression test passed"
