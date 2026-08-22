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

# A reusable workflow cannot elevate above the permissions its caller grants.
# The auto-merge job writes the pull request state, so both generated callers
# must carry the same ceiling or GitHub rejects the workflow before any job is
# scheduled (reported only as startup_failure).
#
# The auto-merge caller is the one pull-request workflow allowed to forward
# secrets, and only the named App credential pair: the App identity is what
# makes the eventual merge push start push workflows, which a merge recorded
# as github-actions[bot] never does. The exception is safe because the called
# workflow runs pinned platform code and never checks out the change under
# review. `secrets: inherit`, or any other secret name, stays forbidden.
for profile in fast major; do
  template="$ROOT_DIR/templates/$profile/.github/workflows/flama-auto-merge.yml.tmpl"
  [[ -f "$template" ]] || { echo "missing auto-merge workflow template" >&2; exit 1; }
  grep -Fqx 'permissions:' "$template"
  grep -Fqx '  contents: write' "$template"
  grep -Fqx '  pull-requests: write' "$template"
  grep -Fq '@__FLAMA_PLATFORM_REF__' "$template"
  grep -Fqx '    secrets:' "$template"
  grep -Fqx '      WORKFLOW_APP_ID: ${{ secrets.WORKFLOW_APP_ID }}' "$template"
  grep -Fqx '      WORKFLOW_APP_PRIVATE_KEY: ${{ secrets.WORKFLOW_APP_PRIVATE_KEY }}' "$template"
  if grep -Eq 'pull_request_target|id-token:|secrets: inherit' "$template"; then
    echo "auto-merge workflow template violates the pull-request trust boundary" >&2
    exit 1
  fi
  if grep -Eo 'secrets\.[A-Za-z0-9_]+' "$template" | grep -Evq '^secrets\.WORKFLOW_APP_(ID|PRIVATE_KEY)$'; then
    echo "auto-merge workflow template forwards a secret outside the App credential pair" >&2
    exit 1
  fi
done

# The merge gate holds the merge where GitHub has no required check to hold it
# behind, so it writes the pull request state and needs the same permission
# ceiling as auto-merge. It carries the same narrow secret exception, for the
# same reason: the merge must be attributed to the App or the push it produces
# starts nothing.
for profile in fast major; do
  template="$ROOT_DIR/templates/$profile/.github/workflows/flama-merge-gate.yml.tmpl"
  [[ -f "$template" ]] || { echo "missing merge-gate workflow template" >&2; exit 1; }
  grep -Fqx 'permissions:' "$template"
  grep -Fqx '  contents: write' "$template"
  grep -Fqx '  pull-requests: write' "$template"
  grep -Fqx '  checks: read' "$template"
  grep -Fq '@__FLAMA_PLATFORM_REF__' "$template"
  grep -Fq 'paperclip-app-slug: __FLAMA_PAPERCLIP_APP_SLUG__' "$template"
  grep -Fqx '    secrets:' "$template"
  grep -Fqx '      WORKFLOW_APP_ID: ${{ secrets.WORKFLOW_APP_ID }}' "$template"
  grep -Fqx '      WORKFLOW_APP_PRIVATE_KEY: ${{ secrets.WORKFLOW_APP_PRIVATE_KEY }}' "$template"
  # It runs on `check_run`/`workflow_run`, which never carry a pull request
  # payload; `pull_request_target` here would be a category error as well as a
  # trust-boundary one.
  if grep -Eq 'pull_request_target|id-token:|secrets: inherit' "$template"; then
    echo "merge-gate workflow template violates the trust boundary" >&2
    exit 1
  fi
  if grep -Eo 'secrets\.[A-Za-z0-9_]+' "$template" | grep -Evq '^secrets\.WORKFLOW_APP_(ID|PRIVATE_KEY)$'; then
    echo "merge-gate workflow template forwards a secret outside the App credential pair" >&2
    exit 1
  fi
done

# Auto-merge must know whether the merge gate exists, or it fails closed on a
# repository the gate is already covering.
for profile in fast major; do
  grep -Fqx '      merge-gate: __FLAMA_MERGE_GATE__' \
    "$ROOT_DIR/templates/$profile/.github/workflows/flama-auto-merge.yml.tmpl"
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
