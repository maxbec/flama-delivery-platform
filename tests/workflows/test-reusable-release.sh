#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
WORKFLOW="$ROOT_DIR/.github/workflows/reusable-release.yml"

[[ -f "$WORKFLOW" ]] || { echo "missing release workflow" >&2; exit 1; }
grep -Fqx 'permissions:' "$WORKFLOW"
grep -Fqx '  contents: read' "$WORKFLOW"
grep -Fqx '      id-token: write' "$WORKFLOW"
grep -Fqx '      attestations: write' "$WORKFLOW"
grep -Fqx '      checksum-path:' "$WORKFLOW"
grep -Fqx '      sbom-digest:' "$WORKFLOW"
grep -Fqx '      checksum-digest:' "$WORKFLOW"
grep -Fq '[[ "$FLAMA_EVENT_NAME" != "pull_request" ]]' "$WORKFLOW"
grep -Fq '[[ "$FLAMA_REF_PROTECTED" == "true" ]]' "$WORKFLOW"
grep -Fq '[[ "$FLAMA_HEAD_SHA" == "${GITHUB_SHA}" ]]' "$WORKFLOW"
grep -Fq 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1' "$WORKFLOW"
grep -Fq 'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38' "$WORKFLOW"
grep -Fqx '          node-version-file: .nvmrc' "$WORKFLOW"
# corepack resolves the package manager against whatever node happens to be on
# PATH, so the version has to be pinned from the commit before it runs. Without
# this the release package depends on the runner image: ubuntu-latest ships a
# node, a self-hosted label need not.
[[ $(grep -Fn 'node-version-file: .nvmrc' "$WORKFLOW" | cut -d: -f1) \
  -lt $(grep -Fn 'run: corepack enable' "$WORKFLOW" | cut -d: -f1) ]]
grep -Fq 'actions/attest-build-provenance@977bb373ede98d70efdf65b84cb5f73e068dcc2a' "$WORKFLOW"
grep -Fq 'actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f' "$WORKFLOW"
grep -Fq 'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c' "$WORKFLOW"
grep -Fqx '          persist-credentials: false' "$WORKFLOW"
grep -Fqx '          overwrite: false' "$WORKFLOW"
grep -Fqx '        run: ./scripts/delivery buildable' "$WORKFLOW"
grep -Fq 'sha256sum -c "$(basename "$FLAMA_CHECKSUM_PATH")" --status' "$WORKFLOW"
grep -Fq '[[ "$physical" == "$workspace/"* ]]' "$WORKFLOW"
[[ $(grep -Fc 'sha256sum -c "$FLAMA_CHECKSUM_FILE" --status' "$WORKFLOW") -eq 2 ]]
grep -Fq '${{ inputs.checksum-path }}' "$WORKFLOW"
grep -Fqx '  package:' "$WORKFLOW"
grep -Fqx '  attest:' "$WORKFLOW"
grep -Fqx '    needs: package' "$WORKFLOW"
grep -Fqx '          include-hidden-files: false' "$WORKFLOW"

if grep -Fq './scripts/delivery full' "$WORKFLOW"; then
  echo "release packaging must not repeat the full application suite" >&2
  exit 1
fi

package_section=$(sed -n '/^  package:/,/^  attest:/p' "$WORKFLOW")
if grep -Eq 'id-token: write|attestations: write' <<< "$package_section"; then
  echo "repository package code must not receive attestation identity" >&2
  exit 1
fi
attest_section=$(sed -n '/^  attest:/,$p' "$WORKFLOW")
if grep -Eq 'actions/checkout@|scripts/delivery' <<< "$attest_section"; then
  echo "attestation job must not check out or execute repository code" >&2
  exit 1
fi

if grep -Eq 'pull_request_target|secrets:|continue-on-error:|secrets: inherit' "$WORKFLOW"; then
  echo "release workflow contains a forbidden trust or mutability pattern" >&2
  exit 1
fi
while IFS= read -r action_ref; do
  [[ "$action_ref" =~ ^[0-9a-f]{40}$ ]] || {
    echo "release workflow action is not pinned to a full SHA" >&2
    exit 1
  }
done < <(sed -nE 's/^[[:space:]]*uses:[[:space:]]+[^@]+@([^[:space:]#]+).*/\1/p' "$WORKFLOW")

echo "reusable release workflow policy tests passed"
