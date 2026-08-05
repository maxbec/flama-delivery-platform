#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
OUTPUT_DIR=${1:-"$ROOT_DIR/build/bridge"}

if [[ -e "$OUTPUT_DIR" ]] && find "$OUTPUT_DIR" -mindepth 1 -print -quit | grep -q .; then
  echo 'Bridge bundle output directory must be absent or empty' >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
cd "$ROOT_DIR"
pnpm build
pnpm exec ncc build dist/services/bridge/src/runtime.js \
  --out "$OUTPUT_DIR" \
  --minify \
  --no-cache \
  --license THIRD_PARTY_LICENSES.txt

[[ -f "$OUTPUT_DIR/index.js" ]]
[[ -f "$OUTPUT_DIR/worker.js" ]]
[[ -f "$OUTPUT_DIR/package.json" ]]
[[ -f "$OUTPUT_DIR/THIRD_PARTY_LICENSES.txt" ]]
chmod 755 "$OUTPUT_DIR/index.js"
