#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
SCRIPT="$ROOT_DIR/scripts/delivery"

[[ -x "$SCRIPT" ]]
for command in buildable affected full smoke health; do
  grep -Eq "(^|[|[:space:]])${command}([)|[:space:]])" "$SCRIPT"
done
if "$SCRIPT" unsupported >/dev/null 2>&1; then
  echo "unsupported platform delivery command unexpectedly succeeded" >&2
  exit 1
fi
"$SCRIPT" smoke

echo "platform delivery script tests passed"
