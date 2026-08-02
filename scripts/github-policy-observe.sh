#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: github-policy-observe.sh --repository OWNER/NAME --profile {fast|major}
                               --posture FILE --output FILE

Builds one normalized, identifier-free GitHub policy observation from read-only
repository metadata, for `flama-delivery-ctl github-policy-audit`.

Owner-scoped App installation posture and runner-class separation cannot be
observed from repository metadata. They are read from an approved posture file
and copied through verbatim; the command refuses to run without one, and
refuses an owner the posture does not cover.
USAGE
}

die() {
  printf 'github-policy-observe: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

REPOSITORY=""
PROFILE=""
POSTURE_PATH=""
OUTPUT_PATH=""

while (($# > 0)); do
  case "$1" in
    --repository)
      (($# >= 2)) || die "--repository requires OWNER/NAME"
      REPOSITORY=$2
      shift 2
      ;;
    --profile)
      (($# >= 2)) || die "--profile requires fast or major"
      PROFILE=$2
      shift 2
      ;;
    --posture)
      (($# >= 2)) || die "--posture requires a path"
      POSTURE_PATH=$2
      shift 2
      ;;
    --output)
      (($# >= 2)) || die "--output requires a path"
      OUTPUT_PATH=$2
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      die "unknown argument: $1"
      ;;
  esac
done

require_command jq
require_command gh
require_command base64

[[ "$REPOSITORY" =~ ^(maxbec|navigaite|edilio-app)/[A-Za-z0-9._-]+$ ]] || \
  die "--repository must be OWNER/NAME for an approved owner"
[[ "$PROFILE" == "fast" || "$PROFILE" == "major" ]] || die "--profile must be fast or major"
[[ -n "$POSTURE_PATH" ]] || die "--posture is required: App and runner posture is not observable"
[[ -f "$POSTURE_PATH" ]] || die "posture not found: $POSTURE_PATH"
[[ -n "$OUTPUT_PATH" ]] || die "--output is required"

OWNER=${REPOSITORY%%/*}

jq -e '.schemaVersion == 1 and (.approvalRef | type == "string" and length > 0)' \
  "$POSTURE_PATH" >/dev/null || die "posture is invalid or unapproved"
jq -e --arg owner "$OWNER" '.owners | has($owner)' "$POSTURE_PATH" >/dev/null || \
  die "approved posture does not cover owner: $OWNER"

TASK_TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TASK_TMP_DIR"' EXIT

# Every call below is a GET. gh api without --method never mutates.
gh_get() { gh api "$@"; }

REPO_JSON="$TASK_TMP_DIR/repository.json"
gh_get "repos/$REPOSITORY" > "$REPO_JSON" || die "failed to read repository metadata"

DEFAULT_BRANCH=$(jq -r '.default_branch // ""' "$REPO_JSON")
[[ "$DEFAULT_BRANCH" == "main" || "$DEFAULT_BRANCH" == "dev" ]] || \
  die "default branch '$DEFAULT_BRANCH' is outside the audit contract; normalize it first"

# Protected branches. The audit models at most main and dev; a repository only
# has protection for branches that exist, and an unprotected branch is reported
# with every control off rather than omitted.
BRANCHES_JSON="$TASK_TMP_DIR/branches.json"
printf '[]\n' > "$BRANCHES_JSON"
for branch in main dev; do
  # A Major repository defaults to dev and keeps main as its stable branch, so
  # observing only the default branch left main unseen and every Major
  # repository reporting drift it could not clear. Any branch the contract
  # models is observed when it exists.
  if [[ "$branch" != "$DEFAULT_BRANCH" ]]; then
    gh_get "repos/$REPOSITORY/branches/$branch" >/dev/null 2>&1 || continue
  fi
  protection="$TASK_TMP_DIR/protection-$branch.json"
  if ! gh_get "repos/$REPOSITORY/branches/$branch/protection" > "$protection" 2>/dev/null; then
    # An unprotected branch that exists is drift the audit exists to report; a
    # branch that does not exist is omitted rather than invented.
    printf '{}\n' > "$protection"
  fi
  jq --slurpfile protection "$protection" --arg name "$branch" '
    . + [$protection[0] | (
      # The jq alternative operator substitutes on false as well as null, so a
      # boolean whose real value is false needs an explicit null test.
      def flag($value; $absent): if $value == null then $absent else $value end;
      {
      name: $name,
      requiredChecks: ([(.required_status_checks.contexts // [])[]
        | select(. == "Flama Branch Guard" or . == "Paperclip Preflight"
                 or . == "Flama Policy Gate" or . == "Flama Final Gate")] | unique),
      pullRequestRequired: (.required_pull_request_reviews != null),
      strictChecks: flag(.required_status_checks.strict; false),
      signedCommits: flag(.required_signatures.enabled; false),
      conversationResolution: flag(.required_conversation_resolution.enabled; false),
      forcePush: flag(.allow_force_pushes.enabled; true),
      deletion: flag(.allow_deletions.enabled; true),
      bypassActorCount: (((.restrictions.users // []) | length)
        + ((.restrictions.teams // []) | length)
        + ((.restrictions.apps // []) | length))
    })]
  ' "$BRANCHES_JSON" > "$TASK_TMP_DIR/branches.next" && mv "$TASK_TMP_DIR/branches.next" "$BRANCHES_JSON"
done
jq -e 'length >= 1' "$BRANCHES_JSON" >/dev/null || \
  die "no branch observation for the default branch"

ACTIONS_JSON="$TASK_TMP_DIR/actions.json"
gh_get "repos/$REPOSITORY/actions/permissions" > "$ACTIONS_JSON" || \
  die "failed to read Actions permissions"
WORKFLOW_JSON="$TASK_TMP_DIR/workflow.json"
gh_get "repos/$REPOSITORY/actions/permissions/workflow" > "$WORKFLOW_JSON" || \
  die "failed to read default workflow permissions"

# Which actions a `selected` policy actually permits. Without this the audit
# cannot tell a stricter policy from one that blocks the platform's own
# reusable workflows and fails every run at startup.
ALLOWED_PATTERNS='[]'
if [[ "$(jq -r '.allowed_actions // ""' "$ACTIONS_JSON")" == "selected" ]]; then
  SELECTED_JSON="$TASK_TMP_DIR/selected-actions.json"
  if gh_get "repos/$REPOSITORY/actions/permissions/selected-actions" > "$SELECTED_JSON" 2>/dev/null; then
    ALLOWED_PATTERNS=$(jq -c '.patterns_allowed // []' "$SELECTED_JSON")
  fi
fi

# Workflow trust: every third-party action must be pinned to a full 40-character
# commit SHA, and no workflow may use pull_request_target.
TREE_JSON="$TASK_TMP_DIR/tree.json"
gh_get "repos/$REPOSITORY/git/trees/$DEFAULT_BRANCH?recursive=1" > "$TREE_JSON" || \
  die "failed to read the default-branch tree"
jq -e '.truncated == false' "$TREE_JSON" >/dev/null || die "GitHub returned a truncated tree"

third_party_pins=true
pull_request_target=false
while IFS= read -r workflow_path; do
  [[ -n "$workflow_path" ]] || continue
  body="$TASK_TMP_DIR/workflow-body"
  gh_get "repos/$REPOSITORY/contents/$workflow_path" \
    | jq -r '.content' | tr -d '\n' | base64 -d > "$body" 2>/dev/null || \
    die "failed to read workflow: $workflow_path"
  if grep -Eq '^[[:space:]]*(on:[[:space:]]*)?pull_request_target' "$body"; then
    pull_request_target=true
  fi
  while IFS= read -r reference; do
    [[ -n "$reference" ]] || continue
    # Local (./) and same-repository reusable workflows are not third party.
    [[ "$reference" == ./* ]] && continue
    [[ "$reference" == "$REPOSITORY"@* || "$reference" == "$REPOSITORY/"* ]] && continue
    [[ "$reference" =~ @[0-9a-f]{40}$ ]] || third_party_pins=false
  done < <(grep -Eo '^[[:space:]]*-?[[:space:]]*uses:[[:space:]]*\S+' "$body" | sed -E 's/.*uses:[[:space:]]*//')
done < <(jq -r '[.tree[]?.path | select(startswith(".github/workflows/"))
  | select(endswith(".yml") or endswith(".yaml"))][]' "$TREE_JSON")

vulnerability_alerts=false
if gh_get "repos/$REPOSITORY/vulnerability-alerts" >/dev/null 2>&1; then
  vulnerability_alerts=true
fi
security_updates=false
if gh_get "repos/$REPOSITORY/automated-security-fixes" > "$TASK_TMP_DIR/fixes.json" 2>/dev/null; then
  security_updates=$(jq -r '(.enabled // false) and ((.paused // false) | not)' "$TASK_TMP_DIR/fixes.json")
fi

# Version-tag protection through repository rulesets. Only an active tag ruleset
# covering refs/tags/v* counts, and its rules decide whether force-update and
# deletion are still possible.
RULESETS_JSON="$TASK_TMP_DIR/rulesets.json"
printf '[]\n' > "$RULESETS_JSON"
# Rulesets are unavailable on some plans. That is a platform fact the audit
# scores differently from a control that exists and is switched off, so the two
# are distinguished here; any other read failure is not evidence of anything.
tag_available=true
if ! gh_get "repos/$REPOSITORY/rulesets" > "$RULESETS_JSON" 2>"$TASK_TMP_DIR/rulesets.err"; then
  if grep -q "Upgrade to GitHub" "$TASK_TMP_DIR/rulesets.err"; then
    tag_available=false
    printf '[]\n' > "$RULESETS_JSON"
  else
    die "failed to read repository rulesets"
  fi
fi
tag_enabled=false
tag_force_update=true
tag_deletion=true
while IFS= read -r ruleset_id; do
  [[ -n "$ruleset_id" ]] || continue
  detail="$TASK_TMP_DIR/ruleset-$ruleset_id.json"
  gh_get "repos/$REPOSITORY/rulesets/$ruleset_id" > "$detail" 2>/dev/null || continue
  jq -e '.target == "tag" and .enforcement == "active"
    and ((.conditions.ref_name.include // []) | any(. == "refs/tags/v*"))' "$detail" >/dev/null || continue
  tag_enabled=true
  jq -e '[.rules[]?.type] | any(. == "deletion")' "$detail" >/dev/null && tag_deletion=false
  jq -e '[.rules[]?.type] | any(. == "update" or . == "non_fast_forward")' "$detail" >/dev/null && tag_force_update=false
done < <(jq -r '[.[]? | select(.target == "tag") | .id][]' "$RULESETS_JSON")

code_owners=false
for path in .github/CODEOWNERS CODEOWNERS docs/CODEOWNERS; do
  if gh_get "repos/$REPOSITORY/contents/$path" >/dev/null 2>&1; then
    code_owners=true
    break
  fi
done

PROTECTION_DEFAULT="$TASK_TMP_DIR/protection-$DEFAULT_BRANCH.json"
[[ -f "$PROTECTION_DEFAULT" ]] || printf '{}\n' > "$PROTECTION_DEFAULT"

jq -n \
  --arg profile "$PROFILE" \
  --arg defaultBranch "$DEFAULT_BRANCH" \
  --slurpfile repository "$REPO_JSON" \
  --slurpfile branches "$BRANCHES_JSON" \
  --slurpfile actions "$ACTIONS_JSON" \
  --slurpfile workflow "$WORKFLOW_JSON" \
  --slurpfile protection "$PROTECTION_DEFAULT" \
  --slurpfile posture "$(printf '%s' "$POSTURE_PATH")" \
  --arg owner "$OWNER" \
  --argjson thirdPartyFullShaPins "$third_party_pins" \
  --argjson allowedPatterns "$ALLOWED_PATTERNS" \
  --argjson pullRequestTarget "$pull_request_target" \
  --argjson vulnerabilityAlerts "$vulnerability_alerts" \
  --argjson securityUpdates "$security_updates" \
  --argjson tagAvailable "$tag_available" \
  --argjson tagEnabled "$tag_enabled" \
  --argjson tagForceUpdate "$tag_force_update" \
  --argjson tagDeletion "$tag_deletion" \
  --argjson codeOwners "$code_owners" '
  ($repository[0]) as $repo |
  ($protection[0]) as $branch |
  ($posture[0]) as $approved |
  # GitHub exposes secret scanning and push protection only when the plan makes
  # them available; an absent block means unavailable, not silently disabled.
  (($repo.security_and_analysis.secret_scanning.status // null)) as $secretScanning |
  (($repo.security_and_analysis.secret_scanning_push_protection.status // null)) as $pushProtection |
  {
    schemaVersion: 1,
    repository: {
      profile: $profile,
      visibility: (if $repo.private then "private" else "public" end),
      isFork: ($repo.fork // false),
      isArchived: ($repo.archived // false),
      defaultBranch: $defaultBranch,
      autoMerge: ($repo.allow_auto_merge // false),
      deleteHeadBranch: ($repo.delete_branch_on_merge // false)
    },
    protectedBranches: $branches[0],
    merge: {
      squash: ($repo.allow_squash_merge // false),
      mergeCommit: ($repo.allow_merge_commit // false),
      rebase: ($repo.allow_rebase_merge // false)
    },
    actions: {
      defaultWorkflowPermissions: ($workflow[0].default_workflow_permissions // "write"),
      workflowCanApprovePullRequests: ($workflow[0].can_approve_pull_request_reviews // false),
      # Actions disabled is enabled:false, which the alternative operator would
      # have turned back into true; that repository runs no actions at all.
      policy: (if ($actions[0].enabled == false) then "local_only"
               else ($actions[0].allowed_actions // "all") end),
      thirdPartyFullShaPins: $thirdPartyFullShaPins,
      allowedPatterns: $allowedPatterns,
      pullRequestTarget: $pullRequestTarget
    },
    security: {
      # GitHub exposes one switch for repository vulnerability alerting; the
      # audit reads it under both of its historical names.
      vulnerabilityAlerts: $vulnerabilityAlerts,
      dependabotAlerts: $vulnerabilityAlerts,
      dependabotSecurityUpdates: $securityUpdates,
      secretScanning: {
        available: ($secretScanning != null),
        enabled: ($secretScanning == "enabled")
      },
      pushProtection: {
        available: ($pushProtection != null),
        enabled: ($pushProtection == "enabled")
      }
    },
    supplyChain: {
      protectedVersionTags: {
        available: $tagAvailable,
        enabled: $tagEnabled,
        pattern: "v*",
        forceUpdate: (if $tagEnabled then $tagForceUpdate else false end),
        deletion: (if $tagEnabled then $tagDeletion else false end)
      },
      # The REST API exposes no immutable-release field. Reporting it
      # unavailable is the observation, not an assumption that it is satisfied.
      immutableReleases: { available: false, enabled: false }
    },
    deployment: {
      codeOwners: $codeOwners,
      staleReviewDismissal: ($branch.required_pull_request_reviews.dismiss_stale_reviews // false),
      pathRestricted: ($branch.required_pull_request_reviews.require_code_owner_reviews // false),
      exactShaApproval: ($branch.required_pull_request_reviews.require_last_push_approval // false)
    },
    githubApp: $approved.owners[$owner].githubApp,
    runners: $approved.runners,
    mutationAllowed: false
  }
' > "$TASK_TMP_DIR/observation.json"

OUTPUT_DIR=$(dirname "$OUTPUT_PATH")
[[ -d "$OUTPUT_DIR" ]] || die "output directory does not exist: $OUTPUT_DIR"
cp "$TASK_TMP_DIR/observation.json" "$OUTPUT_PATH"
printf 'wrote %s\n' "$OUTPUT_PATH"
