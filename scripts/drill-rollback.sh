#!/usr/bin/env bash
# Plan section 20 requires rollback and recovery drills to run from deterministic
# scripts, and plan section 21 phase 6 requires the drill to have been performed
# before the programme is complete.
#
# This drill restores a real deployment to its previous immutable artifact and
# verifies the restore, so it is destructive by design. It refuses to run unless
# it is explicitly authorized and the input is marked as a drill.
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

fail() {
  echo "drill refused: $1" >&2
  exit 1
}

[[ "${FLAMA_DRILL_CONFIRM:-}" == "yes" ]] ||
  fail 'set FLAMA_DRILL_CONFIRM=yes to authorize a drill that restores a real deployment'
[[ -n "${FLAMA_DRILL_MANIFEST:-}" ]] || fail 'set FLAMA_DRILL_MANIFEST to a rollback input path'
[[ -f "${FLAMA_DRILL_MANIFEST}" ]] || fail 'FLAMA_DRILL_MANIFEST is not a file'
[[ -n "${FLAMA_DRILL_ADAPTER:-}" ]] ||
  fail 'set FLAMA_DRILL_ADAPTER to the repository-relative deployment adapter path'
[[ -n "${FLAMA_DRILL_WORKDIR:-}" ]] || fail 'set FLAMA_DRILL_WORKDIR to the consumer checkout'
[[ -d "${FLAMA_DRILL_WORKDIR}" ]] || fail 'FLAMA_DRILL_WORKDIR is not a directory'

command -v jq >/dev/null || fail 'jq is required'

# A drill must be recorded as a drill. Running this against a production incident
# rollback input would produce drill evidence for a real restore.
jq -e '.authorization.drill == true' "${FLAMA_DRILL_MANIFEST}" >/dev/null 2>&1 ||
  fail 'the rollback input is not marked as a drill (authorization.drill must be true)'

CLI="${FLAMA_DRILL_CLI:-$ROOT_DIR/dist/packages/delivery-ctl/src/main.js}"
[[ -f "$CLI" ]] || fail 'build the platform first: the delivery CLI entrypoint is missing'

evidence=${FLAMA_DRILL_EVIDENCE:-}
if [[ -z "$evidence" ]]; then
  evidence=$(mktemp "${TMPDIR:-/tmp}/flama-rollback-drill-XXXXXX.json")
  rm -f "$evidence"
fi

echo "drill: restoring the previous immutable artifact and verifying it" >&2
set +e
node "$CLI" rollback \
  --input "${FLAMA_DRILL_MANIFEST}" \
  --adapter "${FLAMA_DRILL_ADAPTER}" \
  --output "$evidence" \
  --format json
status=$?
set -e

# The drill asserts the recovery guarantees, not merely that the command ran:
# exactly one restore attempt, a verified restore, and drill-marked evidence.
if [[ $status -ne 0 ]]; then
  echo "drill failed: rollback did not report a verified restore" >&2
  [[ -f "$evidence" ]] && jq -e '.attempts == 1' "$evidence" >/dev/null &&
    echo "drill note: exactly one restore attempt was made, as required" >&2
  exit 1
fi

jq -e '.status == "restored" and .attempts == 1 and .drill == true and (.checks | length) >= 2' \
  "$evidence" >/dev/null || fail 'drill evidence does not prove a single verified restore'

echo "rollback drill passed: one verified restore, evidence at $evidence" >&2
