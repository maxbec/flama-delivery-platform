#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
ROLLBACK_DRILL="$ROOT_DIR/scripts/drill-rollback.sh"
REPLAY_DRILL="$ROOT_DIR/scripts/drill-event-replay.mjs"

[[ -f "$ROLLBACK_DRILL" ]] || { echo "missing rollback drill script" >&2; exit 1; }
[[ -f "$REPLAY_DRILL" ]] || { echo "missing event replay drill script" >&2; exit 1; }
bash -n "$ROLLBACK_DRILL"
node --check "$REPLAY_DRILL"

# A drill mutates a real deployment or a real queue. Both scripts must refuse
# every unauthorized or under-specified invocation rather than appearing to pass.

# Each refusal must be attributed to the guard under test. Without matching the
# reason, an unrelated earlier precondition would satisfy the assertion and the
# guard could be deleted without failing anything.
expect_refusal() {
  local description=$1
  local pattern=$2
  shift 2
  local output
  if output=$("$@" 2>&1); then
    echo "drill did not refuse: $description" >&2
    exit 1
  fi
  if ! grep -qE "$pattern" <<<"$output"; then
    echo "drill refused for the wrong reason: $description" >&2
    echo "  expected reason matching: $pattern" >&2
    echo "  actual: $output" >&2
    exit 1
  fi
}

expect_refusal "rollback drill without confirmation" "FLAMA_DRILL_CONFIRM" \
  env -u FLAMA_DRILL_CONFIRM -u FLAMA_DRILL_MANIFEST -u FLAMA_DRILL_ADAPTER \
  bash "$ROLLBACK_DRILL"

expect_refusal "rollback drill confirmed but without a manifest" "FLAMA_DRILL_MANIFEST" \
  env -u FLAMA_DRILL_MANIFEST -u FLAMA_DRILL_ADAPTER FLAMA_DRILL_CONFIRM=yes \
  bash "$ROLLBACK_DRILL"

expect_refusal "rollback drill with a wrong confirmation value" "FLAMA_DRILL_CONFIRM" \
  env FLAMA_DRILL_CONFIRM=y FLAMA_DRILL_MANIFEST=/dev/null FLAMA_DRILL_ADAPTER=provider.cjs \
  bash "$ROLLBACK_DRILL"

expect_refusal "replay drill without a database endpoint" "DATABASE_URL" \
  env -u DATABASE_URL FLAMA_DRILL_CONFIRM=yes node "$REPLAY_DRILL"

expect_refusal "replay drill without confirmation" "FLAMA_DRILL_CONFIRM" \
  env -u FLAMA_DRILL_CONFIRM DATABASE_URL=postgres://localhost/flama node "$REPLAY_DRILL"

# A drill input that is not marked as a drill must be refused, so drill evidence
# can never be produced from a production incident rollback by accident.
drill_dir=$(mktemp -d)
trap 'rm -rf "$drill_dir"' EXIT
jq '.authorization = { "drill": false, "incidentRef": "PRI-1" }' \
  "$ROOT_DIR/tests/fixtures/rollback/valid.json" > "$drill_dir/not-a-drill.json"

# Every other precondition is satisfied here, so only the drill marking can refuse.
expect_refusal "rollback drill given a production rollback input" "not marked as a drill" \
  env FLAMA_DRILL_CONFIRM=yes FLAMA_DRILL_MANIFEST="$drill_dir/not-a-drill.json" \
  FLAMA_DRILL_ADAPTER=provider.cjs FLAMA_DRILL_WORKDIR="$drill_dir" \
  bash "$ROLLBACK_DRILL"

# The drill scripts must never carry a credential or an endpoint of their own.
if grep -nEi '(ghp_|ghs_|github_pat_|sk-|BEGIN [A-Z ]*PRIVATE KEY|password[[:space:]]*=)' \
  "$ROLLBACK_DRILL" "$REPLAY_DRILL"; then
  echo "drill script contains credential material" >&2
  exit 1
fi

echo "recovery drill policy tests passed"
