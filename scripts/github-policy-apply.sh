#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: github-policy-apply.sh --repository OWNER/NAME --profile {fast|major}
                             --plan FILE --posture FILE [--confirm]

Applies only the repairs a planning run classified as auto_repair. Anything
classified as a remediation case, and anything the plan does not contain, is
refused rather than guessed.

Without --confirm nothing is written; the intended requests are printed.

After applying, the repository is observed and audited again, and the command
reports which findings actually cleared. It never reports success from having
issued a request.

Applying repository settings requires an owner-level credential. The delivery
GitHub App deliberately holds no Administration permission and cannot do this.
USAGE
}

die() {
  printf 'github-policy-apply: %s\n' "$*" >&2
  exit 1
}

REPOSITORY=""
PROFILE=""
PLAN_PATH=""
POSTURE_PATH=""
CONFIRM="false"

while (($# > 0)); do
  case "$1" in
    --repository) (($# >= 2)) || die "--repository requires OWNER/NAME"; REPOSITORY=$2; shift 2 ;;
    --profile) (($# >= 2)) || die "--profile requires fast or major"; PROFILE=$2; shift 2 ;;
    --plan) (($# >= 2)) || die "--plan requires a path"; PLAN_PATH=$2; shift 2 ;;
    --posture) (($# >= 2)) || die "--posture requires a path"; POSTURE_PATH=$2; shift 2 ;;
    --confirm) CONFIRM="true"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage; die "unknown argument: $1" ;;
  esac
done

command -v jq >/dev/null 2>&1 || die "required command not found: jq"
command -v gh >/dev/null 2>&1 || die "required command not found: gh"

[[ "$REPOSITORY" =~ ^(maxbec|navigaite|edilio-app)/[A-Za-z0-9._-]+$ ]] || \
  die "--repository must be OWNER/NAME for an approved owner"
[[ "$PROFILE" == "fast" || "$PROFILE" == "major" ]] || die "--profile must be fast or major"
[[ -n "$PLAN_PATH" && -f "$PLAN_PATH" ]] || die "--plan is required and must exist"
[[ -n "$POSTURE_PATH" && -f "$POSTURE_PATH" ]] || die "--posture is required and must exist"

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
POLICY="$ROOT_DIR/policies/branch-profiles.json"
[[ -f "$POLICY" ]] || die "branch profile policy not found"

jq -e '.result.status == "planned"' "$PLAN_PATH" >/dev/null 2>&1 ||
  jq -e '.status == "planned"' "$PLAN_PATH" >/dev/null 2>&1 ||
  die "plan is not a planned repair result"

PLAN=$(jq 'if has("result") then .result else . end' "$PLAN_PATH")

# Only auto_repair survives. A remediation case is a human decision and is never
# applied here, even when the caller passes its plan.
mapfile -t CODES < <(jq -r '[.repairs[] | select(.disposition == "auto_repair") | .code] | sort | .[]' <<<"$PLAN")
((${#CODES[@]} > 0)) || die "plan contains no auto-repairable findings"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

profile_json=$(jq --arg p "$PROFILE" '.profiles[$p]' "$POLICY")
common_json=$(jq '.common' "$POLICY")
merge_commit=$([[ "$PROFILE" == "major" ]] && echo true || echo false)

APPLIED=()
FAILED=()
SKIPPED=()

# Required checks only exist once the repository runs the generated delivery
# workflows. Enforcing them first would make every pull request unmergeable, so
# branch protection is refused until the repository is bootstrapped.
ACTIONS_POLICY_DEFERRED=false
BOOTSTRAPPED=false
if gh api "repos/$REPOSITORY/contents/.flama/delivery-contract.json" >/dev/null 2>&1; then
  BOOTSTRAPPED=true
fi

request() {
  local method=$1 path=$2 body=${3:-}
  if [[ "$CONFIRM" != "true" ]]; then
    printf 'PLAN %s %s %s\n' "$method" "$path" "${body:-}" >&2
    return 0
  fi
  local status=0
  if [[ -n "$body" ]]; then
    gh api -X "$method" "$path" --input - <<<"$body" >/dev/null 2>>"$TMP/err" || status=$?
  else
    gh api -X "$method" "$path" >/dev/null 2>>"$TMP/err" || status=$?
  fi
  if ((status != 0)); then
    # A refused request is recorded, not fatal: some settings are unavailable on
    # some plans, and the verification pass reports what actually changed.
    REQUEST_FAILED=true
    printf 'REFUSED %s %s\n' "$method" "$path" >&2
  fi
  return 0
}

apply_repository_settings() {
  local body
  body=$(jq -nc --argjson mergeCommit "$merge_commit" '{
    allow_squash_merge: true,
    allow_merge_commit: $mergeCommit,
    allow_rebase_merge: false,
    allow_auto_merge: true,
    delete_branch_on_merge: true
  }')
  request PATCH "repos/$REPOSITORY" "$body"
}

apply_actions_policy() {
  # Read-only workflow tokens and no workflow self-approval are safe on any
  # repository and are applied immediately.
  request PUT "repos/$REPOSITORY/actions/permissions/workflow" \
    "$(jq -nc '{default_workflow_permissions: "read", can_approve_pull_request_reviews: false}')"

  # Restricting which actions may run is not safe before the repository runs the
  # generated workflows: an existing workflow that uses an action outside the
  # allow-list stops working the moment this is set. It waits for bootstrap
  # along with branch protection.
  if [[ "$BOOTSTRAPPED" == "true" ]]; then
    request PUT "repos/$REPOSITORY/actions/permissions" \
      "$(jq -nc '{enabled: true, allowed_actions: "selected"}')"
    # An empty pattern list is not a stricter policy. Every reusable workflow
    # lives in another repository — the Flama gates above all — so an allow-list
    # without them fails every run at startup before a single step executes.
    # The patterns come from the approved posture, because the platform cannot
    # infer which actions a repository's existing workflows already depend on,
    # and an allow-list missing one fails every run at startup. The platform's
    # own reusable workflows are always permitted.
    request PUT "repos/$REPOSITORY/actions/permissions/selected-actions" \
      "$(jq -c --arg owner "${REPOSITORY%%/*}" '{
        github_owned_allowed: true,
        verified_allowed: true,
        patterns_allowed: (
          (.owners[$owner].allowedActionPatterns // [])
          + ["maxbec/flama-delivery-platform/*", ($owner + "/*")]
          | unique
        )
      }' "$POSTURE_PATH")"
  else
    ACTIONS_POLICY_DEFERRED=true
    printf 'PARTIAL actions_trust_policy_drift: workflow permissions set; action allow-list deferred until bootstrap\n' >&2
  fi
}

apply_dependency_security() {
  request PUT "repos/$REPOSITORY/vulnerability-alerts"
  request PUT "repos/$REPOSITORY/automated-security-fixes"
}

apply_scanning() {
  # GitHub rejects push protection unless secret scanning is already on, so the
  # two are always sent together and in that order.
  if [[ "$SCANNING_DONE" == "true" ]]; then return 0; fi
  request PATCH "repos/$REPOSITORY" \
    "$(jq -nc '{security_and_analysis: {secret_scanning: {status: "enabled"}}}')"
  request PATCH "repos/$REPOSITORY" \
    "$(jq -nc '{security_and_analysis: {secret_scanning_push_protection: {status: "enabled"}}}')"
  SCANNING_DONE=true
}

branch_checks() {
  local branch=$1
  if [[ "$PROFILE" == "fast" ]]; then
    jq -c '.requiredChecks' <<<"$profile_json"
  elif [[ "$branch" == "dev" ]]; then
    jq -c '.integrationChecks' <<<"$profile_json"
  else
    jq -c '.stableChecks' <<<"$profile_json"
  fi
}

apply_branch_protection() {
  local branch checks body
  local -a branches=()
  if [[ "$PROFILE" == "fast" ]]; then branches=(main); else branches=(dev main); fi
  for branch in "${branches[@]}"; do
    checks=$(branch_checks "$branch")
    body=$(jq -nc --argjson checks "$checks" --argjson common "$common_json" '{
      required_status_checks: { strict: $common.strictChecks, contexts: $checks },
      enforce_admins: true,
      required_pull_request_reviews: {
        dismiss_stale_reviews: true,
        require_code_owner_reviews: true,
        require_last_push_approval: true,
        required_approving_review_count: 0
      },
      restrictions: null,
      required_conversation_resolution: $common.conversationResolution,
      allow_force_pushes: $common.forcePush,
      allow_deletions: $common.branchDeletion
    }')
    request PUT "repos/$REPOSITORY/branches/$branch/protection" "$body"
    # Signature enforcement is a separate endpoint, not a protection field.
    request POST "repos/$REPOSITORY/branches/$branch/protection/required_signatures"
  done
}

apply_tag_protection() {
  local body
  body=$(jq -nc '{
    name: "flama-immutable-version-tags",
    target: "tag",
    enforcement: "active",
    conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
    rules: [ {type: "deletion"}, {type: "update"}, {type: "non_fast_forward"} ]
  }')
  request POST "repos/$REPOSITORY/rulesets" "$body"
}

PROTECTION_DONE=false
SETTINGS_DONE=false
SCANNING_DONE=false
REQUEST_FAILED=false

for code in "${CODES[@]}"; do
  case "$code" in
    branch_protection_drift|required_checks_drift)
      if [[ "$BOOTSTRAPPED" != "true" ]]; then
        SKIPPED+=("$code")
        printf 'SKIP %s: repository has no delivery contract yet; enforcing required checks would block every merge\n' "$code" >&2
        continue
      fi
      ;;
  esac
  case "$code" in
    merge_method_drift|repository_merge_automation_drift)
      if [[ "$SETTINGS_DONE" == "true" ]]; then continue; fi
      apply_repository_settings; SETTINGS_DONE=true ;;
    actions_trust_policy_drift) apply_actions_policy ;;
    dependency_security_disabled) apply_dependency_security ;;
    secret_scanning_disabled|push_protection_disabled) apply_scanning ;;
    branch_protection_drift|required_checks_drift)
      if [[ "$PROTECTION_DONE" == "true" ]]; then continue; fi
      apply_branch_protection; PROTECTION_DONE=true ;;
    version_tag_protection_drift) apply_tag_protection ;;
    *) die "plan contains an auto_repair code this command does not implement: $code" ;;
  esac
  if [[ "$REQUEST_FAILED" == "true" ]]; then FAILED+=("$code"); else APPLIED+=("$code"); fi
  REQUEST_FAILED=false
done

if [[ "$CONFIRM" != "true" ]]; then
  jq -nc --argjson codes "$(printf '%s\n' "${CODES[@]}" | jq -R . | jq -s 'unique')" \
    --argjson skipped "$(printf '%s\n' "${SKIPPED[@]:-}" | jq -R . | jq -s 'map(select(. != "")) | unique')" \
    --argjson bootstrapped "$BOOTSTRAPPED" \
    '{status: "planned", applied: [], bootstrapped: $bootstrapped, wouldApply: ($codes - $skipped), skipped: $skipped}'
  exit 0
fi

# Prove the outcome by observing again, rather than trusting the requests.
OBSERVATION="$TMP/observation.json"
bash "$ROOT_DIR/scripts/github-policy-observe.sh" \
  --repository "$REPOSITORY" --profile "$PROFILE" \
  --posture "$POSTURE_PATH" --output "$OBSERVATION" >/dev/null ||
  die "could not re-observe the repository after applying"

AUDIT="$TMP/audit.json"
node "$ROOT_DIR/dist/packages/delivery-ctl/src/main.js" github-policy-audit \
  --input "$OBSERVATION" > "$AUDIT" 2>&1 || true

jq -nc \
  --argjson attempted "$(printf '%s\n' "${CODES[@]}" | jq -R . | jq -s 'unique')" \
  --slurpfile audit "$AUDIT" '
  ($audit[0].result.findings // []) as $remaining |
  ($remaining | map(.code) | unique) as $remainingCodes |
  {
    status: "applied",
    attempted: $attempted,
    cleared: ($attempted - $remainingCodes),
    stillFailing: ($attempted - ($attempted - $remainingCodes)),
    remainingFindingCount: ($remaining | length)
  }'
