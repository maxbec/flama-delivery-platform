#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
SCRIPT="$ROOT_DIR/scripts/obtain-cli.sh"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/flama-obtain-cli-test-XXXXXX")
trap 'rm -rf "$WORK"' EXIT

sha=$(printf 'a%.0s' {1..40})
other=$(printf 'b%.0s' {1..40})

# A release laid out exactly as the publisher writes it: the tarball, its
# checksum sidecar, and a manifest naming the commit it was cut from.
fake_release() {
  local version=$1 commit=$2 dir="$WORK/releases/v$1" name="flama-delivery-platform-v$1"
  mkdir -p "$dir" "$WORK/build/$name/bin" "$WORK/build/$name/schemas"
  printf '{}\n' > "$WORK/build/$name/schemas/delivery-contract.schema.json"
  printf 'console.log("cli %s");\n' "$version" > "$WORK/build/$name/bin/flama-delivery-ctl.js"
  printf '{"schemaVersion":1,"version":"%s","commitSha":"%s"}\n' "$version" "$commit" > "$WORK/build/$name/release-manifest.json"
  tar -czf "$dir/$name.tar.gz" -C "$WORK/build" "$name"
  (cd "$dir" && sha256sum "$name.tar.gz" > "$name.tar.gz.sha256")
}

mkdir -p "$WORK/checkout"
fake_release 9.9.9 "$sha"
fake_release 9.9.8 "$other"

# Refuses malformed inputs before touching the network.
if "$SCRIPT" not-a-sha "$WORK/out" "$WORK/checkout" >/dev/null 2>&1; then
  echo 'obtain-cli accepted a malformed platform sha' >&2
  exit 1
fi

# A tag source that cannot be read is a failure, never "no release": the
# script must not fall through to a source build because the network blinked.
if FLAMA_PLATFORM_REPOSITORY=maxbec/this-repository-does-not-exist-flama-test \
  FLAMA_RELEASE_ATTESTATION=skip \
  "$SCRIPT" "$sha" "$WORK/out0" "$WORK/checkout" >/dev/null 2>"$WORK/unreadable.err"; then
  echo 'obtain-cli treated an unreadable tag source as no release' >&2
  exit 1
fi
grep -Fq 'could not read platform release tags' "$WORK/unreadable.err"
[[ ! -e "$WORK/out0/flama-delivery-ctl.js" ]]

# Installs the released bundle for a tagged commit, verifying the checksum
# and the manifest's commit. The offline fixture carries no provenance
# attestation, which is the one thing the test seam may switch off.
FLAMA_PLATFORM_TAG_VERSION=9.9.9 FLAMA_RELEASE_BASE_URL="file://$WORK/releases" FLAMA_RELEASE_ATTESTATION=skip \
  "$SCRIPT" "$sha" "$WORK/out" "$WORK/checkout" >/dev/null
[[ -x "$WORK/out/flama-delivery-ctl.js" ]]
[[ "$(node "$WORK/out/flama-delivery-ctl.js")" == "cli 9.9.9" ]]
# The bundle runs from inside the extracted release, beside its schemas.
[[ -f "$WORK/out/release/flama-delivery-platform-v9.9.9/schemas/delivery-contract.schema.json" ]]

# A release cut from another commit is refused even when its checksum is fine:
# the consumer pinned a commit, not a tag that may since have moved.
if FLAMA_PLATFORM_TAG_VERSION=9.9.8 FLAMA_RELEASE_BASE_URL="file://$WORK/releases" FLAMA_RELEASE_ATTESTATION=skip \
  "$SCRIPT" "$sha" "$WORK/out2" "$WORK/checkout" >/dev/null 2>&1; then
  echo 'obtain-cli accepted a release built from a different commit' >&2
  exit 1
fi

# A tampered tarball fails the checksum.
printf 'x' >> "$WORK/releases/v9.9.9/flama-delivery-platform-v9.9.9.tar.gz"
if FLAMA_PLATFORM_TAG_VERSION=9.9.9 FLAMA_RELEASE_BASE_URL="file://$WORK/releases" FLAMA_RELEASE_ATTESTATION=skip \
  "$SCRIPT" "$sha" "$WORK/out3" "$WORK/checkout" >/dev/null 2>&1; then
  echo 'obtain-cli accepted a tarball that fails its checksum' >&2
  exit 1
fi

echo "obtain-cli tests passed"
