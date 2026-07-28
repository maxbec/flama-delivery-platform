#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
TMP_DIR=$(mktemp -d)
mkdir -p "$TMP_DIR/scripts" "$TMP_DIR/.flama"
cp "$ROOT_DIR/templates/common/scripts/delivery" "$TMP_DIR/scripts/delivery"
cp "$ROOT_DIR/templates/common/.flama/run-command.mjs" "$TMP_DIR/.flama/run-command.mjs"
chmod +x "$TMP_DIR/scripts/delivery"

printf '%s\n' '{' \
  '  "buildable": ["node", "-e", "process.stdout.write(\"buildable-ok\")"],' \
  '  "affected": ["node", "-e", "process.exit(0)"],' \
  '  "full": ["node", "-e", "process.exit(0)"],' \
  '  "smoke": ["node", "-e", "process.exit(0)"],' \
  '  "health": ["node", "-e", "process.exit(0)"]' \
  '}' > "$TMP_DIR/.flama/commands.json"

output=$(cd "$TMP_DIR" && ./scripts/delivery buildable)
[[ "$output" == "buildable-ok" ]]

if (cd "$TMP_DIR" && ./scripts/delivery arbitrary >/dev/null 2>&1); then
  echo "arbitrary delivery command unexpectedly succeeded" >&2
  exit 1
fi

if (cd "$TMP_DIR" && ./scripts/delivery buildable extra >/dev/null 2>&1); then
  echo "extra delivery arguments unexpectedly succeeded" >&2
  exit 1
fi

grep -Fq 'shell: false' "$ROOT_DIR/templates/common/.flama/run-command.mjs"
echo "delivery entrypoint template tests passed"
