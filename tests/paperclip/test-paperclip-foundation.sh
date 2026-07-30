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

jq -e '
  .upstream == {
    distribution: "released-package",
    integration: "documented-apis-and-adapters",
    sourceModification: "deny"
  } and
  (.deliveryControllers | length) == 3 and
  all(.deliveryControllers[];
    .placement == "paperclip-company-agent" and
    .adapterType == "process" and
    .initialStatus == "paused" and
    .budgetMonthlyCents == 0
  ) and
  .governanceController == {
    name: "flama-governance-controller",
    placement: "paperclip-orchestrated-job",
    scope: "cross-company",
    identityModel: "native-company-controller-attestations",
    dataPolicy: "metadata-only",
    writeAuthority: []
  }
' "$ROOT_DIR/policies/paperclip-topology.json" >/dev/null

jq -e '
  .company.name == "Private" and
  .controller == "maxbec-delivery-controller" and
  .mutationAllowed == true
' "$ROOT_DIR/tests/fixtures/paperclip-foundation/valid.json" >/dev/null

jq -e '
  .properties.company.additionalProperties == false and
  .properties.company.properties.id.format == "uuid" and
  .properties.mutationAllowed.const == true and
  (.allOf | length) == 3
' "$ROOT_DIR/schemas/paperclip-foundation-input.schema.json" >/dev/null

jq -e '
  .properties.pipelines.minItems == 3 and
  .properties.pipelines.maxItems == 3 and
  .properties.pipelines.items.additionalProperties == false and
  .properties.summary.additionalProperties == false
' "$ROOT_DIR/schemas/paperclip-foundation-result.schema.json" >/dev/null

jq -e '
  .properties.runtimeRoot.type == "string" and
  .properties.mutationAllowed.const == true and
  (.allOf | length) == 3
' "$ROOT_DIR/schemas/paperclip-controllers-input.schema.json" >/dev/null

jq -e '
  .properties.initialStatus.const == "paused" and
  .properties.budgetMonthlyCents.const == 0 and
  .properties.contractDigest.pattern == "^sha256:[0-9a-f]{64}$"
' "$ROOT_DIR/schemas/paperclip-controllers-result.schema.json" >/dev/null

jq -e '
  .properties.repository.properties.isFork.const == false and
  .properties.repository.properties.isArchived.const == false and
  .properties.repository.properties.inventoryVerifiedAt.format == "date-time" and
  .properties.project.properties.id.format == "uuid" and
  .properties.workspace.properties.id.format == "uuid" and
  (.allOf | length) == 3
' "$ROOT_DIR/schemas/paperclip-binding-input.schema.json" >/dev/null

jq -e '
  .properties.bindingDigest.pattern == "^sha256:[0-9a-f]{64}$" and
  (.properties | has("repository") | not) and
  (.properties | has("company") | not) and
  (.properties | has("project") | not) and
  (.properties | has("workspace") | not)
' "$ROOT_DIR/schemas/paperclip-binding-result.schema.json" >/dev/null

jq -e '
  .properties.mutationAllowed.const == true and
  .properties.case.additionalProperties == false and
  (.properties.transitionKind.enum | index("pull_request.merged") != null) and
  (.allOf | length) == 3
' "$ROOT_DIR/schemas/paperclip-transition-authorization-input.schema.json" >/dev/null

jq -e '
  .properties.authorizationDigest.pattern == "^sha256:[0-9a-f]{64}$" and
  .additionalProperties == false
' "$ROOT_DIR/schemas/paperclip-transition-authorization-result.schema.json" >/dev/null

jq -e '
  .properties.scopes.minItems == 3 and
  .properties.scopes.maxItems == 3 and
  (.properties.scopes.allOf | length) == 3 and
  (.properties.scopes.items.properties | has("companyId") | not) and
  .properties.scopes.items.properties.paperclipAttestation.properties.runId.format == "uuid" and
  .properties.scopes.items.properties.paperclipAttestation.properties.source.const == "paperclip-company-controller" and
  .properties.scopes.items.properties.paperclipAttestation.properties.evidenceDigest.pattern == "^sha256:[0-9a-f]{64}$" and
  .properties.scopes.items.properties.repositories.maxItems == 100
' "$ROOT_DIR/schemas/governance-input.schema.json" >/dev/null

jq -e '
  ."$defs".paperclip.additionalProperties == false and
  ."$defs".delivery.additionalProperties == false and
  (.properties.scopes.items.properties | has("companyId") | not) and
  (.properties.scopes.items.properties | has("repositories") | not)
' "$ROOT_DIR/schemas/governance-result.schema.json" >/dev/null

jq -e '.states == ["Intake", "Classified", "Repository Prepared", "Baseline Green", "Ready"]' \
  "$ROOT_DIR/lifecycles/project-bootstrap.json" >/dev/null
jq -e '.states == ["Backlog", "Spec Ready", "Implementing", "Preflight Passed", "PR Open", "Merged", "Done"]' \
  "$ROOT_DIR/lifecycles/feature-fix.json" >/dev/null
jq -e '.states == ["Collecting Changes", "Production Verification", "Released", "Deployment PR Open", "Awaiting Owner Approval", "Deploying", "Verified", "Closed"]' \
  "$ROOT_DIR/lifecycles/release-deployment.json" >/dev/null

jq -e '
  .key == "flama-nightly-reconciliation-v1" and
  .initialStatus == "paused" and
  .concurrencyPolicy == "coalesce_if_active" and
  .catchUpPolicy == "skip_missed" and
  .trigger.kind == "schedule" and
  .trigger.enabled == true and
  .trigger.timezone == "Europe/Berlin" and
  (.trigger.cronByCompany | keys | sort) == ["// Navigaite", "Edilio", "Private"]
' "$ROOT_DIR/routines/nightly-reconciliation.json" >/dev/null

jq -e '
  .properties.controllerAgentId.format == "uuid" and
  .properties.projectId.format == "uuid" and
  .properties.mutationAllowed.const == true and
  (.allOf | length) == 3
' "$ROOT_DIR/schemas/paperclip-routines-input.schema.json" >/dev/null

jq -e '
  .properties.initialStatus.const == "paused" and
  .properties.trigger.properties.enabled.const == true and
  .properties.contractDigest.pattern == "^sha256:[0-9a-f]{64}$"
' "$ROOT_DIR/schemas/paperclip-routines-result.schema.json" >/dev/null

jq -e '
  .key == "flama-github-transition-v1" and
  .initialStatus == "paused" and
  .concurrencyPolicy == "always_enqueue" and
  .trigger.kind == "webhook" and
  .trigger.signingMode == "hmac_sha256" and
  .trigger.replayWindowSeconds == 300 and
  .trigger.credentialSource == "infisical-oidc"
' "$ROOT_DIR/routines/github-transition.json" >/dev/null

jq -e '
  .properties.infisical.properties.sourceOfTruth.const == true and
  .properties.infisical.properties.credentialSource.const == "infisical-oidc" and
  .properties.paperclipSecretStorageException.properties.destination.const == "provider_native_secret" and
  .properties.paperclipSecretStorageException.properties.status.const == "approved" and
  .properties.mutationAllowed.const == true
' "$ROOT_DIR/schemas/paperclip-github-transition-routine-input.schema.json" >/dev/null

jq -e '
  .properties.initialStatus.const == "paused" and
  .properties.trigger.properties.signingMode.const == "hmac_sha256" and
  .properties.infisicalSynced.type == "boolean" and
  .properties.contractDigest.pattern == "^sha256:[0-9a-f]{64}$" and
  .properties.exceptionDigest.pattern == "^sha256:[0-9a-f]{64}$"
' "$ROOT_DIR/schemas/paperclip-github-transition-routine-result.schema.json" >/dev/null

jq -e '
  .properties.company.properties.id.format == "uuid" and
  .properties.controls.properties.maximumAuthorizationRecords.maximum == 1000 and
  .properties.mutationAllowed.const == false and
  (.allOf | length) == 3
' "$ROOT_DIR/schemas/reconciliation-input.schema.json" >/dev/null

jq -e '
  .properties.mode.const == "read_only" and
  (.properties | has("company") | not) and
  (.properties | has("companyId") | not) and
  (.properties | has("repositories") | not)
' "$ROOT_DIR/schemas/reconciliation-result.schema.json" >/dev/null

jq -e '
  .properties.mode.const == "read_only" and
  .properties.database.properties.activeBindings."$ref" == "#/$defs/count" and
  (.properties | has("companyId") | not) and
  (.properties | has("repositories") | not)
' "$ROOT_DIR/schemas/reconciliation-evidence.schema.json" >/dev/null

echo "Paperclip foundation contracts passed"
