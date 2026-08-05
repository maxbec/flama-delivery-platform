#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
mkdir -p "$ROOT_DIR/build"
FIRST=$(mktemp -d "$ROOT_DIR/build/controller-first-XXXXXX")
SECOND=$(mktemp -d "$ROOT_DIR/build/controller-second-XXXXXX")

bash "$ROOT_DIR/scripts/build-controller-bundle.sh" "$FIRST"
bash "$ROOT_DIR/scripts/build-controller-bundle.sh" "$SECOND"

diff -rq "$FIRST" "$SECOND"
[[ -x "$FIRST/index.js" ]]
[[ "$(jq -r '.type' "$FIRST/package.json")" == "module" ]]
if output=$(env -i PATH="$PATH" NODE_ENV=production node "$FIRST/index.js" 2>&1); then
  echo 'Controller bundle unexpectedly started without a Paperclip run identity' >&2
  exit 1
fi
[[ "$output" == '{"error":{"code":"controller_identity_unavailable"},"ok":false}' ]]

echo "deterministic controller bundle tests passed"
