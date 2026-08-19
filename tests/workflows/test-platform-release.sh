#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
WORKFLOW="$ROOT_DIR/.github/workflows/release.yml"
CONFIG="$ROOT_DIR/.release-please-config.json"

[[ -f "$WORKFLOW" ]] || { echo "missing platform release workflow" >&2; exit 1; }
grep -Fqx '  "skip-github-release": true,' "$CONFIG"
grep -Fqx '  contents: read' "$WORKFLOW"
grep -Fqx '  prepare-release:' "$WORKFLOW"
grep -Fqx '  publish-release:' "$WORKFLOW"
grep -Fqx '      id-token: write' "$WORKFLOW"
grep -Fqx '      attestations: write' "$WORKFLOW"
grep -Fq 'Infisical/secrets-action@77ab1f4ccd183a543cb5b42435fbd181189f4995' "$WORKFLOW"
grep -Fq 'actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1' "$WORKFLOW"
grep -Fq 'app-id: ${{ env.FLAMA_GITHUB_APP_ID_MAXBEC }}' "$WORKFLOW"
grep -Fq 'private-key: ${{ env.FLAMA_GITHUB_APP_PRIVATE_KEY_MAXBEC }}' "$WORKFLOW"
grep -Fq 'permission-contents: write' "$WORKFLOW"
grep -Fq 'repositories: flama-delivery-platform' "$WORKFLOW"
grep -Fq 'actions/attest-build-provenance@977bb373ede98d70efdf65b84cb5f73e068dcc2a' "$WORKFLOW"
# The release is created as a draft and published by clearing that flag. Both
# assertions must use `gh api` field syntax: a field is split on its first `=`,
# so `-F draft:='false'` sends a field named `draft:`, leaves the release a
# draft, and still returns 200 -- a green step that published nothing.
grep -Fq -- '-F draft=true' "$WORKFLOW"
grep -Fq -- '-F draft=false' "$WORKFLOW"
grep -Fq 'repos/${GITHUB_REPOSITORY}/immutable-releases' "$WORKFLOW"
grep -Fq '[[ "$FLAMA_REF_PROTECTED" == "true" ]]' "$WORKFLOW"
grep -Fq '[[ "$FLAMA_RELEASE_SHA" == "$GITHUB_SHA" ]]' "$WORKFLOW"
grep -Fq 'sha256sum -c "$FLAMA_CHECKSUM_FILE" --status' "$WORKFLOW"

# The release pull request must be authored by the App, never by GITHUB_TOKEN.
# GitHub suppresses workflow runs on GITHUB_TOKEN-authored pull requests, so a
# release pull request opened that way is born unmergeable: Foundation Gate
# never reports. Assert the token wiring rather than the absence of a string,
# because the fallback would read as green while shipping the old behaviour.
release_pr_section=$(sed -n '/^  release-please:/,/^  prepare-release:/p' "$WORKFLOW")
grep -Fq 'token: ${{ steps.release-pr-app.outputs.token }}' <<< "$release_pr_section"
grep -Fq 'permission-pull-requests: write' <<< "$release_pr_section"
if grep -Fq 'secrets.GITHUB_TOKEN' <<< "$release_pr_section"; then
  echo "release pull request must not be authored by GITHUB_TOKEN" >&2
  exit 1
fi

prepare_section=$(sed -n '/^  prepare-release:/,/^  publish-release:/p' "$WORKFLOW")
if grep -Eq 'id-token: write|attestations: write|contents: write|Infisical/secrets-action|create-github-app-token' <<< "$prepare_section"; then
  echo "release preparation must not receive publishing identity" >&2
  exit 1
fi

publish_section=$(sed -n '/^  publish-release:/,$p' "$WORKFLOW")
if grep -Eq 'actions/checkout@|scripts/delivery|pnpm |npm |node scripts/' <<< "$publish_section"; then
  echo "release publisher must not check out or execute repository code" >&2
  exit 1
fi

attestation_line=$(grep -n 'name: Attest platform release assets' "$WORKFLOW" | cut -d: -f1)
publish_line=$(grep -n 'name: Publish immutable release' "$WORKFLOW" | cut -d: -f1)
[[ -n "$attestation_line" && -n "$publish_line" && "$attestation_line" -lt "$publish_line" ]]

if grep -Eq 'pull_request_target|continue-on-error:|secrets: inherit|skip-token-revoke: true|--clobber' "$WORKFLOW"; then
  echo "platform release workflow contains a forbidden trust or mutability pattern" >&2
  exit 1
fi
if grep -Eq 'FLAMA_RELEASE_GITHUB_APP_(ID|PRIVATE_KEY)' "$WORKFLOW"; then
  echo "platform release workflow must reuse the owner-matched Maxbec App credentials" >&2
  exit 1
fi
while IFS= read -r action_ref; do
  [[ "$action_ref" =~ ^[0-9a-f]{40}$ ]] || {
    echo "platform release action is not pinned to a full SHA" >&2
    exit 1
  }
done < <(sed -nE 's/^[[:space:]]*uses:[[:space:]]+[^@]+@([^[:space:]#]+).*/\1/p' "$WORKFLOW")

echo "platform release workflow policy tests passed"
