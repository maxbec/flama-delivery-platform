#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

required_schemas=(
  bootstrap-input.schema.json
  bootstrap-result.schema.json
  repository-inventory.schema.json
  inventory-audit-result.schema.json
  delivery-contract.schema.json
  preflight-evidence.schema.json
  preflight-run-input.schema.json
  preflight-run-result.schema.json
  publish-check-input.schema.json
  publish-check-result.schema.json
  promotion-input.schema.json
  promotion-result.schema.json
  release-evidence-input.schema.json
  release-evidence-result.schema.json
  platform-release-manifest.schema.json
  paperclip-controller.schema.json
  paperclip-foundation-input.schema.json
  paperclip-foundation-result.schema.json
  paperclip-lifecycle.schema.json
  deployment-manifest.schema.json
  deployment-pr-input.schema.json
  deployment-result.schema.json
  secret-exceptions.schema.json
  secrets-audit-input.schema.json
  render-input.schema.json
)

for schema in "${required_schemas[@]}"; do
  path="$ROOT_DIR/schemas/$schema"
  [[ -f "$path" ]] || { echo "missing schema: $schema" >&2; exit 1; }
  jq -e '
    ."$schema" == "https://json-schema.org/draft/2020-12/schema" and
    (."$id" | startswith("https://github.com/maxbec/flama-delivery-platform/schemas/")) and
    .type == "object" and
    .additionalProperties == false and
    (.required | type == "array" and length > 0)
  ' "$path" >/dev/null
done

jq -e '
  .profiles.fast.requiredChecks == ["Branch Guard", "Paperclip Preflight", "Final Gate"] and
  .profiles.major.integrationChecks == ["Branch Guard", "Paperclip Preflight", "Policy Gate"] and
  .profiles.major.stableChecks == ["Branch Guard", "Final Gate"] and
  .common.normalBypassActors == [] and
  .common.forcePush == false
' "$ROOT_DIR/policies/branch-profiles.json" >/dev/null

jq -e '
  .sourceOfTruth == "infisical" and
  all(.publicPullRequest[]; . == "deny") and
  .trustedJobs.productionAfterApprovalOnly == true and
  .trustedJobs.broadSecretInheritance == "deny" and
  all(.plaintext[]; . == "deny")
' "$ROOT_DIR/policies/secrets.json" >/dev/null

jq -e '
  .pool == "flama-ci-budget" and
  .controls.mandatoryGateMaySkip == false and
  .controls.transientRetryLimit == 1 and
  .controls.deterministicRetryLimit == 0
' "$ROOT_DIR/policies/ci-budget.json" >/dev/null

jq -e '
  .version == 1 and
  .schedule.interval == "weekly" and
  .schedule.weekdayStrategy == "repository_sha256_modulo_weekdays" and
  .requiredEcosystems == ["github-actions"] and
  .openPullRequestsLimit == 1 and
  .groups["routine-updates"].updateTypes == ["minor", "patch"] and
  .securityUpdates == "enabled" and
  .majorUpdates == "paperclip"
' "$ROOT_DIR/policies/dependabot.json" >/dev/null

jq -e '
  .mutationGuard.forks == "deny" and
  .mutationGuard.archived == "deny" and
  .mutationGuard.unknownOwners == "deny" and
  .platformRepositories == ["maxbec/flama-delivery-platform"]
' "$ROOT_DIR/policies/repository-scope.json" >/dev/null

echo "contract and policy tests passed"
