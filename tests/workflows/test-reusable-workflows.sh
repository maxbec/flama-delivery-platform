#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
POLICY="$ROOT_DIR/.github/workflows/reusable-policy.yml"
FINAL="$ROOT_DIR/.github/workflows/reusable-final.yml"
BRANCH_GUARD="$ROOT_DIR/.github/workflows/reusable-branch-guard.yml"

for workflow in "$BRANCH_GUARD" "$POLICY" "$FINAL"; do
  [[ -f "$workflow" ]] || { echo "missing reusable workflow" >&2; exit 1; }
  grep -Fqx 'permissions:' "$workflow"
  grep -Fqx '  contents: read' "$workflow"
  grep -Fq 'inputs.head-sha' "$workflow"
  if grep -Eq 'pull_request_target|id-token:|secrets:|continue-on-error:|secrets: inherit' "$workflow"; then
    echo "reusable workflow contains a forbidden trust or mutability pattern" >&2
    exit 1
  fi
  while IFS= read -r action_ref; do
    [[ "$action_ref" =~ ^[0-9a-f]{40}$ ]] || {
      echo "reusable workflow action is not pinned to a full SHA" >&2
      exit 1
    }
  done < <(sed -nE 's/^[[:space:]]*uses:[[:space:]]+[^@]+@([^[:space:]#]+).*/\1/p' "$workflow")
done

grep -Fqx '    name: Flama Branch Guard' "$BRANCH_GUARD"
grep -Fq 'github.event.pull_request.head.sha' "$BRANCH_GUARD"
for workflow in "$POLICY" "$FINAL"; do
  grep -Fq 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1' "$workflow"
  grep -Fqx '          persist-credentials: false' "$workflow"
done
grep -Fqx '    name: Flama Policy Gate' "$POLICY"
grep -Fqx '  checks: read' "$POLICY"
grep -Fq 'consumer-policy-gate.mjs' "$POLICY"
grep -Fq 'check_name=Paperclip%20Preflight' "$POLICY"
# A gate that samples once fails on a preflight that has not been published
# yet and never looks again, so the verdict stays red until someone re-runs it.
# It must wait for absence and decide immediately on a completed failure.
grep -Fq 'inputs.preflight-wait-seconds' "$POLICY"
grep -Fq 'sleep 30' "$POLICY"
grep -Fq '.conclusion != "success"' "$POLICY"
grep -Fq "if: \${{ steps.change.outputs.mode == 'code' }}" "$POLICY"
grep -Fqx '          fetch-depth: 0' "$POLICY"
if grep -Eq './scripts/delivery (buildable|affected|full)' "$POLICY"; then
  echo "policy workflow duplicates application tests" >&2
  exit 1
fi
grep -Fqx '    name: Flama Final Gate' "$FINAL"
grep -Fqx '        run: ./scripts/delivery full' "$FINAL"
grep -Fq "if: \${{ steps.change.outputs.mode == 'code' }}" "$FINAL"
grep -Fq "if: \${{ steps.change.outputs.mode == 'deployment' }}" "$FINAL"
grep -Fq -- '--schema deployment-manifest' "$FINAL"
grep -Fqx '          fetch-depth: 0' "$FINAL"

echo "reusable workflow policy tests passed"
