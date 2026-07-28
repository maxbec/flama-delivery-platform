#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

skill="$ROOT_DIR/skills/flama-paperclip-delivery/SKILL.md"
[[ -f "$skill" ]]
grep -Fq 'name: flama-paperclip-delivery' "$skill"
if grep -R -En 'TODO|\[TODO' "$ROOT_DIR/skills/flama-paperclip-delivery" >/dev/null; then
  echo 'Paperclip skill contains unfinished placeholders' >&2
  exit 1
fi

for owner in maxbec navigaite edilio; do
  controller="$ROOT_DIR/lifecycles/controllers/${owner}-delivery-controller.json"
  jq -e --arg owner "$owner" '
    .mode == "company-delivery" and
    .scope.githubOwners == [$owner] and
    (.authority.deny | contains(["git_push", "git_merge", "production_approval", "production_deploy", "secret_values"]))
  ' "$controller" >/dev/null
done

jq -e '
  .mode == "global-governance" and
  .authority.write == [] and
  .runtime.maxImplementationConcurrency == 0
' "$ROOT_DIR/lifecycles/controllers/flama-governance-controller.json" >/dev/null

jq -e '.states == ["Intake", "Classified", "Repository Prepared", "Baseline Green", "Ready"]' \
  "$ROOT_DIR/lifecycles/project-bootstrap.json" >/dev/null
jq -e '.states == ["Backlog", "Spec Ready", "Implementing", "Preflight Passed", "PR Open", "Merged", "Done"]' \
  "$ROOT_DIR/lifecycles/feature-fix.json" >/dev/null
jq -e '.states == ["Collecting Changes", "Production Verification", "Released", "Deployment PR Open", "Awaiting Owner Approval", "Deploying", "Verified", "Closed"]' \
  "$ROOT_DIR/lifecycles/release-deployment.json" >/dev/null

echo "Paperclip foundation contracts passed"
