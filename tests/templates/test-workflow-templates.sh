#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

for profile in fast major; do
  for gate in branch-guard policy final; do
    template="$ROOT_DIR/templates/$profile/.github/workflows/flama-$gate.yml.tmpl"
    [[ -f "$template" ]] || { echo "missing workflow template" >&2; exit 1; }
    grep -Fqx 'permissions:' "$template"
    grep -Fqx '  contents: read' "$template"
    grep -Fq '@__FLAMA_PLATFORM_REF__' "$template"
    if grep -Eq 'pull_request_target|id-token:|secrets:|secrets: inherit' "$template"; then
      echo "workflow template violates the untrusted lane" >&2
      exit 1
    fi
  done
done

deploy_template="$ROOT_DIR/templates/common/.github/workflows/flama-deploy.yml.tmpl"
grep -Fq '@__FLAMA_PLATFORM_REF__' "$deploy_template"
grep -Fqx '      platform-sha: __FLAMA_PLATFORM_REF__' "$deploy_template"
grep -Fqx '    if: ${{ github.event.pull_request.merged == true }}' "$deploy_template"
grep -Fqx '      id-token: write' "$deploy_template"
if grep -Eq 'pull_request_target|secrets:|secrets: inherit' "$deploy_template"; then
  echo "deploy workflow template violates the trusted lane" >&2
  exit 1
fi

grep -Fqx '    branches: [main]' "$ROOT_DIR/templates/fast/.github/workflows/flama-policy.yml.tmpl"
grep -Fqx '    branches: [dev]' "$ROOT_DIR/templates/major/.github/workflows/flama-policy.yml.tmpl"
grep -Fqx '  checks: read' "$ROOT_DIR/templates/fast/.github/workflows/flama-policy.yml.tmpl"
grep -Fqx '  checks: read' "$ROOT_DIR/templates/major/.github/workflows/flama-policy.yml.tmpl"
grep -Fqx '    branches: [main]' "$ROOT_DIR/templates/fast/.github/workflows/flama-final.yml.tmpl"
grep -Fqx '    branches: [main]' "$ROOT_DIR/templates/major/.github/workflows/flama-final.yml.tmpl"
grep -Fqx '    branches: [main]' "$ROOT_DIR/templates/fast/.github/workflows/flama-branch-guard.yml.tmpl"
grep -Fqx '    branches: [dev, main]' "$ROOT_DIR/templates/major/.github/workflows/flama-branch-guard.yml.tmpl"
if grep -Rq '^  push:' "$ROOT_DIR/templates/fast/.github/workflows/flama-final.yml.tmpl" "$ROOT_DIR/templates/major/.github/workflows/flama-final.yml.tmpl"; then
  echo "final gate runs after merge instead of on the main-boundary pull request" >&2
  exit 1
fi

echo "workflow template policy tests passed"
