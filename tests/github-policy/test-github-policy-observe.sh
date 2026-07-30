#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
FIXTURE_DIR="$ROOT_DIR/tests/fixtures/github-policy-observe"
OBSERVER="$ROOT_DIR/scripts/github-policy-observe.sh"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

chmod +x "$FIXTURE_DIR/bin/gh"

run_observer() {
  PATH="$FIXTURE_DIR/bin:$PATH" "$OBSERVER" "$@"
}

OUTPUT="$TMP_DIR/observation.json"
run_observer \
  --repository maxbec/example \
  --profile fast \
  --posture "$FIXTURE_DIR/posture.json" \
  --output "$OUTPUT" >/dev/null

# The observation must equal the checked-in golden, which the TypeScript suite
# validates against the audit-input schema.
if ! diff -u "$FIXTURE_DIR/expected-observation.json" "$OUTPUT"; then
  echo "observer output drifted from the golden observation" >&2
  exit 1
fi

# Declared posture is copied through verbatim, never inferred.
jq -e --slurpfile posture "$FIXTURE_DIR/posture.json" '
  .githubApp == $posture[0].owners.maxbec.githubApp and
  .runners == $posture[0].runners
' "$OUTPUT" >/dev/null || {
  echo "declared posture was not copied through verbatim" >&2
  exit 1
}

jq -e '.mutationAllowed == false' "$OUTPUT" >/dev/null

# An owner absent from the approved posture must fail closed rather than
# producing an observation with plausible defaults.
jq 'del(.owners.maxbec) | .owners.navigaite = {
  githubApp: {
    ownerScoped: true, repositorySelection: "selected", installationTokens: "short_lived",
    leastPrivilegePermissions: true, webhookEventsExact: true,
    administration: false, secretAdministration: false
  }
}' "$FIXTURE_DIR/posture.json" > "$TMP_DIR/other-owner.json"
if run_observer --repository maxbec/example --profile fast \
  --posture "$TMP_DIR/other-owner.json" --output "$TMP_DIR/nope.json" >/dev/null 2>&1; then
  echo "observer accepted an owner missing from the approved posture" >&2
  exit 1
fi
[[ ! -e "$TMP_DIR/nope.json" ]]

# A posture file is mandatory: the App and runner facts are not observable.
# Assert the refusal reason, so this cannot pass because of a later failure.
if run_observer --repository maxbec/example --profile fast \
  --output "$TMP_DIR/nope2.json" >/dev/null 2>"$TMP_DIR/no-posture.err"; then
  echo "observer produced an observation without an approved posture" >&2
  exit 1
fi
grep -q -- '--posture is required' "$TMP_DIR/no-posture.err" || {
  echo "missing posture was not refused for being missing" >&2
  cat "$TMP_DIR/no-posture.err" >&2
  exit 1
}

# The audit contract only models main/dev. A master default branch must stop the
# run instead of being silently reported as something else.
if PATH="$FIXTURE_DIR/bin:$PATH" FLAMA_GH_DEFAULT_BRANCH=master "$OBSERVER" \
  --repository maxbec/example --profile fast \
  --posture "$FIXTURE_DIR/posture.json" --output "$TMP_DIR/nope3.json" \
  >/dev/null 2>"$TMP_DIR/branch.err"; then
  echo "observer accepted a default branch outside the audit contract" >&2
  exit 1
fi
grep -q "outside the audit contract" "$TMP_DIR/branch.err" || {
  echo "master default branch was not refused for being outside the contract" >&2
  cat "$TMP_DIR/branch.err" >&2
  exit 1
}

# An unprotected default branch is drift the audit must be able to see, not a
# reason to refuse to look. Every control is reported off.
PATH="$FIXTURE_DIR/bin:$PATH" FLAMA_GH_NO_PROTECTION=1 "$OBSERVER" \
  --repository maxbec/example --profile fast \
  --posture "$FIXTURE_DIR/posture.json" --output "$TMP_DIR/unprotected.json" >/dev/null

jq -e '
  (.protectedBranches | length) == 1 and
  .protectedBranches[0] == {
    name: "main", requiredChecks: [], pullRequestRequired: false, strictChecks: false,
    signedCommits: false, conversationResolution: false, forcePush: true,
    deletion: true, bypassActorCount: 0
  } and
  .deployment.staleReviewDismissal == false and
  .deployment.pathRestricted == false and
  .deployment.exactShaApproval == false
' "$TMP_DIR/unprotected.json" >/dev/null || {
  echo "unprotected default branch was not reported as fully unprotected" >&2
  jq '.protectedBranches, .deployment' "$TMP_DIR/unprotected.json" >&2
  exit 1
}

echo "github policy observer tests passed"
