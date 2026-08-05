#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
FIXTURE_DIR="$ROOT_DIR/tests/fixtures/github-policy-apply"
APPLY="$ROOT_DIR/scripts/github-policy-apply.sh"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

chmod +x "$FIXTURE_DIR/bin/gh"

plan() {
  jq -n --argjson repairs "$1" --argjson cases "${2:-[]}" '{
    schemaVersion: 1, status: "planned", profile: "fast",
    contractDigest: "sha256:\("0" * 64)",
    repairs: $repairs, remediationCases: $cases
  }'
}

AUTO='[{"code":"merge_method_drift","location":"merge","disposition":"auto_repair","effect":"x"}]'

# A repository without the delivery contract must not have required checks
# enforced: the checks do not exist yet, so every pull request would be stuck.
plan "$AUTO"'+[{"code":"required_checks_drift","location":"branches","disposition":"auto_repair","effect":"x"}]' \
  > "$TMP_DIR/plan-unbootstrapped.json" 2>/dev/null ||
  jq -n '{schemaVersion:1,status:"planned",profile:"fast",
    contractDigest:"sha256:0000000000000000000000000000000000000000000000000000000000000000",
    repairs:[{code:"merge_method_drift",location:"merge",disposition:"auto_repair",effect:"x"},
             {code:"required_checks_drift",location:"branches",disposition:"auto_repair",effect:"x"}],
    remediationCases:[]}' > "$TMP_DIR/plan-unbootstrapped.json"

PATH="$FIXTURE_DIR/bin:$PATH" FLAMA_GH_NO_CONTRACT=1 "$APPLY" \
  --repository maxbec/example --profile fast \
  --plan "$TMP_DIR/plan-unbootstrapped.json" \
  --posture "$ROOT_DIR/tests/fixtures/github-policy-observe/posture.json" \
  > "$TMP_DIR/unbootstrapped.json" 2>"$TMP_DIR/unbootstrapped.err"

jq -e '.skipped == ["required_checks_drift"] and (.wouldApply | index("required_checks_drift") | not)' \
  "$TMP_DIR/unbootstrapped.json" >/dev/null || {
  echo "required checks were not withheld from an unbootstrapped repository" >&2
  cat "$TMP_DIR/unbootstrapped.json" >&2
  exit 1
}

# A remediation case is a human decision and must never be applied, even when
# the plan that contains it is passed in.
# The case is placed in the repair list as well, so the disposition filter is
# what excludes it rather than the shape of the document.
jq -n '{schemaVersion:1,status:"planned",profile:"fast",
  contractDigest:"sha256:0000000000000000000000000000000000000000000000000000000000000000",
  repairs:[{code:"merge_method_drift",location:"merge",disposition:"auto_repair",effect:"x"},
           {code:"default_branch_drift",location:"repository",
            disposition:"remediation_case",effect:"x"}],
  remediationCases:[{code:"default_branch_drift",location:"repository",
                     disposition:"remediation_case",reason:"breaks_existing_refs"}]}' \
  > "$TMP_DIR/plan-with-case.json"

PATH="$FIXTURE_DIR/bin:$PATH" "$APPLY" \
  --repository maxbec/example --profile fast \
  --plan "$TMP_DIR/plan-with-case.json" \
  --posture "$ROOT_DIR/tests/fixtures/github-policy-observe/posture.json" \
  > "$TMP_DIR/with-case.json" 2>"$TMP_DIR/with-case.err"

jq -e '(.wouldApply | index("default_branch_drift")) == null' "$TMP_DIR/with-case.json" >/dev/null || {
  echo "a remediation case was scheduled for application" >&2
  exit 1
}
grep -q "default_branch_drift" "$TMP_DIR/with-case.err" && {
  echo "a remediation case reached the request layer" >&2
  exit 1
}

# Without --confirm nothing may be written.
grep -q '^PLAN ' "$TMP_DIR/with-case.err" || {
  echo "planning mode did not describe its intended requests" >&2
  exit 1
}
if grep -qE '^(WROTE|MUTATED) ' "$TMP_DIR/with-case.err"; then
  echo "planning mode issued a mutating request" >&2
  exit 1
fi

# An unimplemented auto_repair code must stop the run rather than be ignored.
jq -n '{schemaVersion:1,status:"planned",profile:"fast",
  contractDigest:"sha256:0000000000000000000000000000000000000000000000000000000000000000",
  repairs:[{code:"some_future_drift",location:"repository",disposition:"auto_repair",effect:"x"}],
  remediationCases:[]}' > "$TMP_DIR/plan-unknown.json"

if PATH="$FIXTURE_DIR/bin:$PATH" "$APPLY" \
  --repository maxbec/example --profile fast \
  --plan "$TMP_DIR/plan-unknown.json" \
  --posture "$ROOT_DIR/tests/fixtures/github-policy-observe/posture.json" \
  >/dev/null 2>"$TMP_DIR/unknown.err"; then
  echo "an unimplemented repair code was silently ignored" >&2
  exit 1
fi
grep -q "does not implement" "$TMP_DIR/unknown.err" || {
  echo "unknown repair code was not refused for being unimplemented" >&2
  cat "$TMP_DIR/unknown.err" >&2
  exit 1
}

echo "github policy apply tests passed"
