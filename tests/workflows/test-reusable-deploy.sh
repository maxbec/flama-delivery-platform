#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
WORKFLOW="$ROOT_DIR/.github/workflows/reusable-deploy.yml"

[[ -f "$WORKFLOW" ]] || { echo "missing deploy workflow" >&2; exit 1; }
grep -Fqx '  contents: read' "$WORKFLOW"
grep -Fqx '    environment: production' "$WORKFLOW"
grep -Fqx '      id-token: write' "$WORKFLOW"
grep -Fqx '      attestations: read' "$WORKFLOW"
grep -Fq '[[ "$FLAMA_EVENT_HEAD_SHA" == "$FLAMA_APPROVED_HEAD_SHA" ]]' "$WORKFLOW"
grep -Fq 'claims.iss !== "https://token.actions.githubusercontent.com"' "$WORKFLOW"
grep -Fq 'claims.aud !== "flama-delivery"' "$WORKFLOW"
grep -Fq 'claims.sub !== `repo:${repository}:environment:production`' "$WORKFLOW"
grep -Fq 'claims.job_workflow_ref !== expectedWorkflow' "$WORKFLOW"
grep -Fq 'deployment-pr' "$WORKFLOW"
grep -Fq -- '--schema deployment-manifest --format yaml' "$WORKFLOW"
grep -Fq 'deploy immutable artifact and verify soak' < <(tr '[:upper:]' '[:lower:]' < "$WORKFLOW")
grep -Fqx '          persist-credentials: false' "$WORKFLOW"
grep -Fqx '          overwrite: false' "$WORKFLOW"

if grep -Eq 'pull_request_target|secrets:|continue-on-error:|secrets: inherit' "$WORKFLOW"; then
  echo "deploy workflow contains a forbidden trust pattern" >&2
  exit 1
fi
while IFS= read -r action_ref; do
  [[ "$action_ref" =~ ^[0-9a-f]{40}$ ]] || {
    echo "deploy workflow action is not pinned to a full SHA" >&2
    exit 1
  }
done < <(sed -nE 's/^[[:space:]]*uses:[[:space:]]+[^@]+@([^[:space:]#]+).*/\1/p' "$WORKFLOW")

echo "reusable deploy workflow policy tests passed"
