#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
TMP_DIR=$(mktemp -d)
trap 'rm -rf -- "$TMP_DIR"' EXIT

git -C "$TMP_DIR" init -q

printf '%s\n' 'safe public content' >"$TMP_DIR/safe.txt"
git -C "$TMP_DIR" add safe.txt
bash "$ROOT_DIR/scripts/public-repository-audit.sh" "$TMP_DIR" >/dev/null
FLAMA_AUDIT_SCANNER=grep bash "$ROOT_DIR/scripts/public-repository-audit.sh" "$TMP_DIR" >/dev/null
export FLAMA_AUDIT_SCANNER=grep

printf '%s%s\n' 'github_pat_' 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' >"$TMP_DIR/credential.txt"
git -C "$TMP_DIR" add credential.txt
if bash "$ROOT_DIR/scripts/public-repository-audit.sh" "$TMP_DIR" >/dev/null 2>&1; then
  echo 'credential signature was not rejected' >&2
  exit 1
fi

git -C "$TMP_DIR" reset -q credential.txt
rm -- "$TMP_DIR/credential.txt"
printf '%s%s\n' 'client_secret=' 'abcdefghijklmnop1234' >"$TMP_DIR/assignment.txt"
git -C "$TMP_DIR" add assignment.txt
if bash "$ROOT_DIR/scripts/public-repository-audit.sh" "$TMP_DIR" >/dev/null 2>&1; then
  echo 'literal secret assignment was not rejected' >&2
  exit 1
fi

git -C "$TMP_DIR" reset -q assignment.txt
rm -- "$TMP_DIR/assignment.txt"
printf '%s%s\n' '{"repositories": [{"nameWithOwner": "owner/private-repository", "visibility": ' '"private"}]}' >"$TMP_DIR/inventory.json"
git -C "$TMP_DIR" add inventory.json
if bash "$ROOT_DIR/scripts/public-repository-audit.sh" "$TMP_DIR" >/dev/null 2>&1; then
  echo 'private repository inventory was not rejected' >&2
  exit 1
fi

git -C "$TMP_DIR" reset -q inventory.json
rm -- "$TMP_DIR/inventory.json"
printf '%s%s\n' 'Paperclip: 12 projects ' 'exist in live inventory' >"$TMP_DIR/paperclip-inventory.txt"
git -C "$TMP_DIR" add paperclip-inventory.txt
if bash "$ROOT_DIR/scripts/public-repository-audit.sh" "$TMP_DIR" >/dev/null 2>&1; then
  echo 'Paperclip inventory measurement was not rejected' >&2
  exit 1
fi

git -C "$TMP_DIR" reset -q paperclip-inventory.txt
rm -- "$TMP_DIR/paperclip-inventory.txt"
mkdir -p "$TMP_DIR/vendor/paperclipai"
printf '%s\n' 'vendored upstream source' >"$TMP_DIR/vendor/paperclipai/server.ts"
git -C "$TMP_DIR" add vendor/paperclipai/server.ts
if bash "$ROOT_DIR/scripts/public-repository-audit.sh" "$TMP_DIR" >/dev/null 2>&1; then
  echo 'vendored PaperclipAI source was not rejected' >&2
  exit 1
fi

git -C "$TMP_DIR" reset -q vendor/paperclipai/server.ts
rm -- "$TMP_DIR/vendor/paperclipai/server.ts"
rmdir "$TMP_DIR/vendor/paperclipai" "$TMP_DIR/vendor"
printf '%s\n' '{"pnpm":{"patchedDependencies":{"paperclipai@1.2.3":"patches/paperclip.patch"}}}' >"$TMP_DIR/package.json"
git -C "$TMP_DIR" add package.json
if bash "$ROOT_DIR/scripts/public-repository-audit.sh" "$TMP_DIR" >/dev/null 2>&1; then
  echo 'PaperclipAI package patch was not rejected' >&2
  exit 1
fi

echo 'public repository audit regression tests passed'
