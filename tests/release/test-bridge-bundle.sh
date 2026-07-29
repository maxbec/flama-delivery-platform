#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
mkdir -p "$ROOT_DIR/build"
FIRST=$(mktemp -d "$ROOT_DIR/build/bridge-first-XXXXXX")
SECOND=$(mktemp -d "$ROOT_DIR/build/bridge-second-XXXXXX")

bash "$ROOT_DIR/scripts/build-bridge-bundle.sh" "$FIRST"
bash "$ROOT_DIR/scripts/build-bridge-bundle.sh" "$SECOND"

diff -rq "$FIRST" "$SECOND"
[[ -x "$FIRST/index.js" ]]
[[ "$(jq -r '.type' "$FIRST/package.json")" == "module" ]]
if output=$(env -i PATH="$PATH" NODE_ENV=production node "$FIRST/index.js" 2>&1); then
  echo 'Bridge bundle unexpectedly started without injected configuration' >&2
  exit 1
fi
[[ "$output" == '{"status":"failed","reason":"bridge_runtime_failure"}' ]]

echo "deterministic bridge bundle tests passed"
