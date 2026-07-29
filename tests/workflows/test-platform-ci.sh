#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
WORKFLOW="$ROOT_DIR/.github/workflows/platform-ci.yml"

[[ -f "$WORKFLOW" ]] || { echo "missing platform CI workflow" >&2; exit 1; }

awk '
  /^permissions:$/ {
    if (getline > 0 && $0 == "  contents: read") found = 1
  }
  END { exit(found ? 0 : 1) }
' "$WORKFLOW"
grep -Fqx '  cancel-in-progress: true' "$WORKFLOW"
grep -Fqx '    name: Foundation Gate' "$WORKFLOW"
grep -Fqx '    timeout-minutes: 10' "$WORKFLOW"
grep -Fq 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1' "$WORKFLOW"
grep -Fq 'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38' "$WORKFLOW"
grep -Fq 'bash tests/contracts/test-contracts.sh' "$WORKFLOW"
grep -Fq 'bash tests/inventory/test-phase0-inventory.sh' "$WORKFLOW"
grep -Fq 'bash tests/paperclip/test-paperclip-foundation.sh' "$WORKFLOW"
grep -Fq 'bash tests/security/test-public-repository-audit.sh' "$WORKFLOW"
grep -Fq 'bash scripts/public-repository-audit.sh' "$WORKFLOW"
grep -Fq 'bash tests/workflows/test-reusable-workflows.sh' "$WORKFLOW"
grep -Fq 'bash tests/workflows/test-reusable-release.sh' "$WORKFLOW"
grep -Fq 'bash tests/workflows/test-reusable-deploy.sh' "$WORKFLOW"
grep -Fq 'bash tests/templates/test-delivery-entrypoint.sh' "$WORKFLOW"
grep -Fq 'bash tests/templates/test-workflow-templates.sh' "$WORKFLOW"
grep -Fq 'pnpm install --frozen-lockfile' "$WORKFLOW"
grep -Fq 'run: pnpm typecheck' "$WORKFLOW"
grep -Fq 'run: pnpm test' "$WORKFLOW"
grep -Fq 'bash tests/release/test-cli-bundle.sh' "$WORKFLOW"
grep -Fq 'bash tests/release/test-bridge-bundle.sh' "$WORKFLOW"
grep -Fq 'bash tests/release/test-governance-bundle.sh' "$WORKFLOW"
grep -Fq 'bash tests/release/test-platform-release.sh' "$WORKFLOW"
grep -Fq 'bash tests/scripts/test-delivery-script.sh' "$WORKFLOW"
grep -Fq 'find lifecycles policies schemas tests/fixtures' "$WORKFLOW"

if grep -Eq 'pull_request_target|id-token:|secrets:|continue-on-error:|@[A-Za-z][A-Za-z0-9._-]*([[:space:]]|$)' "$WORKFLOW"; then
  echo "platform CI contains a forbidden trust or mutability pattern" >&2
  exit 1
fi

echo "platform CI policy test passed"
