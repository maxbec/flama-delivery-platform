#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# Read the version rather than hard-coding it: the release name is derived
# from package.json, so a pinned version turns every release into a failing
# build. That is exactly what the first version bump did.
VERSION=$(node -p "require('$ROOT_DIR/package.json').version")
RELEASE="flama-delivery-platform-v$VERSION"
FIRST=$(mktemp -d)
SECOND=$(mktemp -d)

node "$ROOT_DIR/scripts/build-platform-release.mjs" --output-dir "$FIRST" >/dev/null
node "$ROOT_DIR/scripts/build-platform-release.mjs" --output-dir "$SECOND" >/dev/null

artifact="$RELEASE.tar.gz"
sbom="$RELEASE.sbom.spdx.json"
cmp "$FIRST/$artifact" "$SECOND/$artifact"
cmp "$FIRST/$sbom" "$SECOND/$sbom"
cmp "$FIRST/$artifact.sha256" "$SECOND/$artifact.sha256"
(cd "$FIRST" && sha256sum -c "$artifact.sha256")

archive_listing=$(tar -tzf "$FIRST/$artifact")
grep -Fqx "$RELEASE/bin/flama-delivery-ctl.js" <<< "$archive_listing"
grep -Fqx "$RELEASE/bin/bridge/index.js" <<< "$archive_listing"
grep -Fqx "$RELEASE/bin/bridge/worker.js" <<< "$archive_listing"
grep -Fqx "$RELEASE/bin/controller/index.js" <<< "$archive_listing"
grep -Fqx "$RELEASE/bin/governance/index.js" <<< "$archive_listing"
grep -Fqx "$RELEASE/release-manifest.json" <<< "$archive_listing"
grep -Fqx "$RELEASE/$sbom" <<< "$archive_listing"
grep -Fqx "$RELEASE/lifecycles/feature-fix.json" <<< "$archive_listing"
grep -Fqx "$RELEASE/routines/nightly-reconciliation.json" <<< "$archive_listing"
grep -Fqx "$RELEASE/routines/github-transition.json" <<< "$archive_listing"
grep -Fqx "$RELEASE/schemas/paperclip-github-transition-routine-input.schema.json" <<< "$archive_listing"
grep -Fqx "$RELEASE/schemas/paperclip-github-transition-routine-result.schema.json" <<< "$archive_listing"
grep -Fqx "$RELEASE/skills/flama-paperclip-delivery/SKILL.md" <<< "$archive_listing"
grep -Fqx "$RELEASE/services/bridge/migrations/002_repository_bindings.sql" <<< "$archive_listing"
grep -Fqx "$RELEASE/services/bridge/migrations/004_external_transition_authorizations.sql" <<< "$archive_listing"
grep -Fqx "$RELEASE/services/bridge/migrations/005_reconciliation_indexes.sql" <<< "$archive_listing"
grep -Fqx "$RELEASE/scripts/consumer-policy-gate.mjs" <<< "$archive_listing"

EXTRACTED=$(mktemp -d)
tar -xzf "$FIRST/$artifact" -C "$EXTRACTED"
release_root="$EXTRACTED/$RELEASE"
[[ "$(node "$release_root/bin/flama-delivery-ctl.js" --version)" == "{\"toolVersion\":\"$VERSION\"}" ]]
jq -e '
  .spdxVersion == "SPDX-2.3" and
  (.packages | length > 1) and
  all(.packages[]; has("path") | not)
' "$FIRST/$sbom" >/dev/null
if grep -Fq "$ROOT_DIR" "$FIRST/$sbom"; then
  echo "SBOM contains a local filesystem path" >&2
  exit 1
fi
jq -e --arg version "$VERSION" '
  .schemaVersion == 1 and
  .version == $version and
  .nodeMajor == 26 and
  .cli == "bin/flama-delivery-ctl.js" and
  .bridge == "bin/bridge/index.js" and
  .controller == "bin/controller/index.js" and
  .governance == "bin/governance/index.js" and
  (.commitSha | test("^[0-9a-f]{40}$")) and
  (.files | length > 10)
' "$release_root/release-manifest.json" >/dev/null
node "$release_root/bin/flama-delivery-ctl.js" validate \
  --schema platform-release-manifest \
  --input "$release_root/release-manifest.json" >/dev/null

echo "deterministic platform release tests passed"
