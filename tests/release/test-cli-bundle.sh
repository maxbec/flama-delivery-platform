#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
mkdir -p "$ROOT_DIR/build"
FIRST=$(mktemp -d "$ROOT_DIR/build/cli-first-XXXXXX")
SECOND=$(mktemp -d "$ROOT_DIR/build/cli-second-XXXXXX")

bash "$ROOT_DIR/scripts/build-cli-bundle.sh" "$FIRST"
bash "$ROOT_DIR/scripts/build-cli-bundle.sh" "$SECOND"

cmp "$FIRST/index.js" "$SECOND/index.js"
cmp "$FIRST/THIRD_PARTY_LICENSES.txt" "$SECOND/THIRD_PARTY_LICENSES.txt"
cmp "$FIRST/package.json" "$SECOND/package.json"
[[ -x "$FIRST/index.js" ]]
output=$(cd "$ROOT_DIR" && node "$FIRST/index.js" --version)
[[ "$output" == '{"toolVersion":"0.1.0"}' ]]

(cd "$ROOT_DIR" && node "$FIRST/index.js" preflight \
  --dry-run \
  --input packages/contracts/test/fixtures/preflight-run-input.valid.json \
  > "$FIRST/preflight-plan.json")
jq -e '
  .ok == true and
  .command == "preflight" and
  .result.commands == ["./scripts/delivery buildable", "./scripts/delivery affected"]
' "$FIRST/preflight-plan.json" >/dev/null

(cd "$ROOT_DIR" && node "$FIRST/index.js" inventory \
  --input packages/contracts/test/fixtures/repository-inventory.valid.json \
  > "$FIRST/inventory-audit.json")
jq -e '.ok == true and .result.status == "passed" and .result.summary.inScope == 1' \
  "$FIRST/inventory-audit.json" >/dev/null
if grep -Fq 'maxbec/example' "$FIRST/inventory-audit.json"; then
  echo 'bundled inventory command exposed a repository name' >&2
  exit 1
fi

bootstrap_repo=$(mktemp -d "$ROOT_DIR/build/bootstrap-repository-XXXXXX")
git -C "$bootstrap_repo" init --initial-branch=main >/dev/null
git -C "$bootstrap_repo" config user.name 'Bootstrap Bundle Test'
git -C "$bootstrap_repo" config user.email 'bootstrap@example.invalid'
git -C "$bootstrap_repo" remote add origin https://github.com/maxbec/example.git
cp "$ROOT_DIR/README.md" "$bootstrap_repo/README.md"
git -C "$bootstrap_repo" add README.md
git -C "$bootstrap_repo" commit -m initial >/dev/null
bootstrap_sha=$(git -C "$bootstrap_repo" rev-parse HEAD)
git -C "$bootstrap_repo" update-ref refs/remotes/origin/main "$bootstrap_sha"
jq --arg sha "$bootstrap_sha" '.baseSha = $sha' \
  "$ROOT_DIR/tests/fixtures/bootstrap/fast.json" > "$FIRST/bootstrap-input.json"
(cd "$ROOT_DIR" && node "$FIRST/index.js" bootstrap \
  --dry-run \
  --input "$FIRST/bootstrap-input.json" \
  --output "$bootstrap_repo" \
  > "$FIRST/bootstrap-plan.json")
jq -e '
  .ok == true and
  .command == "bootstrap" and
  .result.status == "planned" and
  (.result.generated.files | length) == 10 and
  (.result.repositoryOwned | length) == 7
' "$FIRST/bootstrap-plan.json" >/dev/null
if grep -Eq 'maxbec/example|project-1|workspace-1' "$FIRST/bootstrap-plan.json"; then
  echo 'bundled bootstrap command exposed repository binding identifiers' >&2
  exit 1
fi
test ! -e "$bootstrap_repo/.flama/platform-lock.json"

(cd "$ROOT_DIR" && node "$FIRST/index.js" bootstrap \
  --input "$FIRST/bootstrap-input.json" \
  --output "$bootstrap_repo" \
  > "$FIRST/bootstrap-result.json")
jq -e '.ok == true and .result.status == "prepared"' "$FIRST/bootstrap-result.json" >/dev/null
node "$ROOT_DIR/scripts/consumer-policy-gate.mjs" \
  "$bootstrap_repo" \
  main \
  fast \
  aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  flama-maxbec-delivery \
  > "$FIRST/consumer-policy.json"
jq -e '.ok == true and .profile == "fast" and .baseRef == "main"' \
  "$FIRST/consumer-policy.json" >/dev/null
jq '.secrets.unexpected = "redacted-placeholder"' \
  "$bootstrap_repo/.flama/delivery-contract.json" > "$FIRST/tampered-contract.json"
mv "$FIRST/tampered-contract.json" "$bootstrap_repo/.flama/delivery-contract.json"
if node "$ROOT_DIR/scripts/consumer-policy-gate.mjs" \
  "$bootstrap_repo" \
  main \
  fast \
  aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  flama-maxbec-delivery \
  >/dev/null 2>&1; then
  echo 'consumer policy accepted an unknown secret field' >&2
  exit 1
fi

(cd "$ROOT_DIR" && node "$FIRST/index.js" publish-check \
  --dry-run \
  --input tests/fixtures/publish-check/valid.json \
  > "$FIRST/publish-check-plan.json")
jq -e '
  .ok == true and
  .command == "publish-check" and
  .result.status == "planned" and
  .result.check.name == "Paperclip Preflight" and
  .result.check.conclusion == "success"
' "$FIRST/publish-check-plan.json" >/dev/null
if grep -Eq 'maxbec/example|runner-example' "$FIRST/publish-check-plan.json"; then
  echo 'bundled publish-check command exposed repository or runner identifiers' >&2
  exit 1
fi

(cd "$ROOT_DIR" && node "$FIRST/index.js" promote \
  --dry-run \
  --input tests/fixtures/promote/valid.json \
  > "$FIRST/promotion-plan.json")
jq -e '
  .ok == true and
  .command == "promote" and
  .result.status == "planned" and
  .result.profile == "major" and
  .result.promotion.action == "create_or_reuse"
' "$FIRST/promotion-plan.json" >/dev/null
if grep -Eq 'maxbec/example|flama-maxbec-delivery' "$FIRST/promotion-plan.json"; then
  echo 'bundled promotion command exposed repository or app identity' >&2
  exit 1
fi

(cd "$ROOT_DIR" && node "$FIRST/index.js" release-evidence \
  --dry-run \
  --input tests/fixtures/release-evidence/valid.json \
  > "$FIRST/release-evidence-plan.json")
jq -e '
  .ok == true and
  .command == "release-evidence" and
  .result.status == "planned" and
  .result.requiredFiles == 3 and
  .result.verification.assetAttestations == 3
' "$FIRST/release-evidence-plan.json" >/dev/null
if grep -Eq 'maxbec/example|release/example' "$FIRST/release-evidence-plan.json"; then
  echo 'bundled release evidence command exposed repository or local path identifiers' >&2
  exit 1
fi

(cd "$ROOT_DIR" && node "$FIRST/index.js" reconcile \
  --dry-run \
  --input tests/fixtures/reconciliation/valid.json \
  > "$FIRST/reconciliation-plan.json")
jq -e '
  .ok == true and
  .command == "reconcile" and
  .result.status == "planned" and
  .result.mode == "read_only" and
  (.result.evidenceDigest? == null)
' "$FIRST/reconciliation-plan.json" >/dev/null
if grep -Fq '10000000-0000-4000-8000-000000000001' "$FIRST/reconciliation-plan.json"; then
  echo 'bundled reconciliation command exposed a company identifier' >&2
  exit 1
fi

(cd "$ROOT_DIR" && node "$FIRST/index.js" paperclip-github-transition-routine \
  --dry-run \
  --input tests/fixtures/paperclip-github-transition-routine/valid.json \
  > "$FIRST/github-transition-routine-plan.json")
jq -e '
  .ok == true and
  .command == "paperclip-github-transition-routine" and
  .result.status == "planned" and
  .result.initialStatus == "paused" and
  .result.infisicalSynced == false and
  .result.trigger.signingMode == "hmac_sha256"
' "$FIRST/github-transition-routine-plan.json" >/dev/null
if grep -Eq '10000000-0000-4000-8000-000000000001|40000000-0000-4000-8000-000000000004|/flama/paperclip/private|webhookSecret' \
  "$FIRST/github-transition-routine-plan.json"; then
  echo 'bundled GitHub-transition routine command exposed private mapping or secret material' >&2
  exit 1
fi

evidence="$FIRST/deployment-result.json"
if (cd "$ROOT_DIR" && node "$FIRST/index.js" deploy \
  --format yaml \
  --input tests/fixtures/provider/deployment-manifest.custom.yaml \
  --adapter tests/fixtures/provider/provider.cjs \
  --output "$evidence" > "$FIRST/deploy-output.json"); then
  echo "bundle adapter validation unexpectedly passed" >&2
  exit 1
fi
jq -e '.status == "failed" and .reasonCode == "adapter_validation_failed"' "$evidence" >/dev/null

rollback_output="$FIRST/rollback-plan.json"
(cd "$ROOT_DIR" && node "$FIRST/index.js" rollback \
  --dry-run \
  --input tests/fixtures/rollback/valid.json > "$rollback_output")
jq -e '
  .command == "rollback" and
  .dryRun == true and
  .ok == true and
  .result.status == "planned" and
  .result.drill == true and
  .result.attempts == 0 and
  (.result | has("startedAt") | not) and
  (.result | has("providerEvidence") | not)
' "$rollback_output" >/dev/null
if grep -qE 'ghcr\.io|PRI-' "$rollback_output"; then
  echo 'bundled rollback command exposed an artifact reference or incident identifier' >&2
  exit 1
fi

echo "deterministic CLI bundle tests passed"
