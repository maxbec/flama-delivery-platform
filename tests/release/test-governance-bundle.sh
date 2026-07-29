#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
mkdir -p "$ROOT_DIR/build"
FIRST=$(mktemp -d "$ROOT_DIR/build/governance-first-XXXXXX")
SECOND=$(mktemp -d "$ROOT_DIR/build/governance-second-XXXXXX")

bash "$ROOT_DIR/scripts/build-governance-bundle.sh" "$FIRST"
bash "$ROOT_DIR/scripts/build-governance-bundle.sh" "$SECOND"

diff -rq "$FIRST" "$SECOND"
[[ -x "$FIRST/index.js" ]]
[[ "$(jq -r '.type' "$FIRST/package.json")" == "module" ]]
if output=$(env -i PATH="$PATH" NODE_ENV=production node "$FIRST/index.js" 2>&1); then
  echo 'Governance bundle unexpectedly ran without private input and output paths' >&2
  exit 1
fi
[[ "$output" == '{"status":"failed","reason":"governance_runtime_failure"}' ]]

echo "deterministic governance bundle tests passed"
