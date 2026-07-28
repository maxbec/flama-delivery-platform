#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: phase0-inventory.sh --policy FILE (--live | --fixture FILE) --output FILE [--observed-at RFC3339]

Builds a secret-free repository inventory. Live mode performs read-only GitHub
queries. The command fails closed when the observed owner counts differ from the
approved policy, and it never marks forks, archived repositories, or unknown
owners as mutation candidates.
USAGE
}

die() {
  printf 'phase0-inventory: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

POLICY_PATH=""
FIXTURE_PATH=""
OUTPUT_PATH=""
OBSERVED_AT=""
MODE=""

while (($# > 0)); do
  case "$1" in
    --policy)
      (($# >= 2)) || die "--policy requires a path"
      POLICY_PATH=$2
      shift 2
      ;;
    --fixture)
      (($# >= 2)) || die "--fixture requires a path"
      [[ -z "$MODE" ]] || die "choose exactly one of --live or --fixture"
      MODE="fixture"
      FIXTURE_PATH=$2
      shift 2
      ;;
    --live)
      [[ -z "$MODE" ]] || die "choose exactly one of --live or --fixture"
      MODE="live"
      shift
      ;;
    --output)
      (($# >= 2)) || die "--output requires a path"
      OUTPUT_PATH=$2
      shift 2
      ;;
    --observed-at)
      (($# >= 2)) || die "--observed-at requires an RFC3339 timestamp"
      OBSERVED_AT=$2
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
require_command base64
[[ -n "$POLICY_PATH" ]] || die "--policy is required"
[[ -f "$POLICY_PATH" ]] || die "policy not found: $POLICY_PATH"
[[ -n "$MODE" ]] || die "choose exactly one of --live or --fixture"
[[ -n "$OUTPUT_PATH" ]] || die "--output is required"
[[ "$OUTPUT_PATH" != "$POLICY_PATH" ]] || die "output must not overwrite policy"

if [[ "$MODE" == "fixture" ]]; then
  [[ -f "$FIXTURE_PATH" ]] || die "fixture not found: $FIXTURE_PATH"
else
  require_command gh
  gh auth status >/dev/null 2>&1 || die "GitHub CLI is not authenticated"
fi

if [[ -z "$OBSERVED_AT" ]]; then
  OBSERVED_AT=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
fi
[[ "$OBSERVED_AT" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || \
  die "--observed-at must use UTC RFC3339 form YYYY-MM-DDTHH:MM:SSZ"

jq -e '
  .version == 1 and
  (.owners | type == "object" and length > 0) and
  (.platformRepositories | type == "array") and
  .inclusion == {owned:true,fork:false,archived:false} and
  .mutationGuard.forks == "deny" and
  .mutationGuard.archived == "deny" and
  .mutationGuard.unknownOwners == "deny" and
  .mutationGuard.inventoryOnlyExclusions == true
' "$POLICY_PATH" >/dev/null || die "policy is invalid or weakens mandatory mutation guards"

TASK_TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TASK_TMP_DIR"' EXIT
RAW_PATH="$TASK_TMP_DIR/repositories.json"
RESULT_PATH="$TASK_TMP_DIR/inventory.json"

gh_read() {
  local output_file error_file retry_output retry_error jitter
  output_file=$(mktemp "$TASK_TMP_DIR/gh-output.XXXXXX")
  error_file=$(mktemp "$TASK_TMP_DIR/gh-error.XXXXXX")

  if gh "$@" >"$output_file" 2>"$error_file"; then
    cat "$output_file"
    return 0
  fi

  if ! grep -Eqi 'error connecting|timed? out|timeout|connection reset|temporary failure|HTTP 5[0-9]{2}|secondary rate|rate limit' "$error_file"; then
    cat "$error_file" >&2
    return 1
  fi

  jitter=$((1 + BASHPID % 3))
  sleep "$jitter"
  retry_output=$(mktemp "$TASK_TMP_DIR/gh-retry-output.XXXXXX")
  retry_error=$(mktemp "$TASK_TMP_DIR/gh-retry-error.XXXXXX")
  if gh "$@" >"$retry_output" 2>"$retry_error"; then
    cat "$retry_output"
    return 0
  fi

  cat "$retry_error" >&2
  return 1
}

normalize_fixture() {
  jq -e '
    if type != "array" then error("fixture must be an array") else . end |
    map({
      nameWithOwner,
      isFork,
      isArchived,
      isPrivate,
      defaultBranch,
      defaultBranchHeadSha,
      primaryLanguage: (.primaryLanguage // "unknown"),
      pushedAt,
      paths: (.paths // []),
      defaultBranchStatus: (.defaultBranchStatus // null),
      latestWorkflow: (.latestWorkflow // null)
    })
  ' "$FIXTURE_PATH"
}

collect_live_repo() {
  local encoded=$1
  local repo_json repo branch active tree_json paths_file branch_json workflow_json status_json
  local primary pushed

  repo_json=$(printf '%s' "$encoded" | base64 -d)
  repo=$(jq -r '.nameWithOwner' <<<"$repo_json")
  branch=$(jq -r '.defaultBranchRef.name // ""' <<<"$repo_json")
  primary=$(jq -r '.primaryLanguage.name // "unknown"' <<<"$repo_json")
  pushed=$(jq -r '.pushedAt // ""' <<<"$repo_json")
  active=$(jq -r '((.isFork | not) and (.isArchived | not))' <<<"$repo_json")

  paths_file=$(mktemp "$TASK_TMP_DIR/repository-paths.XXXXXX")
  printf '[]\n' > "$paths_file"
  branch_json='null'
  workflow_json='null'
  status_json=$(jq '.defaultBranchRef.target.statusCheckRollup.state // null' <<<"$repo_json")

  if [[ "$active" == "true" ]]; then
    [[ -n "$branch" ]] || die "in-scope repository has no default branch: $repo"
    tree_json=$(gh_read api "repos/$repo/git/trees/$branch?recursive=1") || \
      die "failed to read default-branch tree for $repo"
    jq -e '.truncated == false' <<<"$tree_json" >/dev/null || \
      die "GitHub returned a truncated tree for $repo"
    jq '[.tree[]?.path]' <<<"$tree_json" > "$paths_file"

    branch_json=$(jq '.defaultBranchRef.target.oid // null' <<<"$repo_json")
  fi

  jq -nc \
    --arg nameWithOwner "$repo" \
    --argjson isFork "$(jq '.isFork' <<<"$repo_json")" \
    --argjson isArchived "$(jq '.isArchived' <<<"$repo_json")" \
    --argjson isPrivate "$(jq '.isPrivate' <<<"$repo_json")" \
    --arg defaultBranch "$branch" \
    --argjson defaultBranchHeadSha "$branch_json" \
    --arg primaryLanguage "$primary" \
    --arg pushedAt "$pushed" \
    --slurpfile paths "$paths_file" \
    --argjson defaultBranchStatus "$status_json" \
    --argjson latestWorkflow "$workflow_json" \
    '{
      nameWithOwner: $nameWithOwner,
      isFork: $isFork,
      isArchived: $isArchived,
      isPrivate: $isPrivate,
      defaultBranch: $defaultBranch,
      defaultBranchHeadSha: $defaultBranchHeadSha,
      primaryLanguage: $primaryLanguage,
      pushedAt: $pushedAt,
      paths: $paths[0],
      defaultBranchStatus: $defaultBranchStatus,
      latestWorkflow: $latestWorkflow
    }'
}

wait_for_batch() {
  local failed=0 pid
  for pid in "${BATCH_PIDS[@]}"; do
    if ! wait "$pid"; then
      failed=1
    fi
  done
  BATCH_PIDS=()
  ((failed == 0)) || die "one or more live repository queries failed"
}

collect_live() {
  local owner owner_index=0 encoded job_index=0 output_file query
  local -a owner_files=()
  BATCH_PIDS=()

  while IFS= read -r owner; do
    output_file="$TASK_TMP_DIR/owner-$owner_index.json"
    query='query($owner:String!){repositoryOwner(login:$owner){repositories(first:100,ownerAffiliations:OWNER,orderBy:{field:NAME,direction:ASC}){nodes{nameWithOwner isFork isArchived isPrivate pushedAt primaryLanguage{name} defaultBranchRef{name target{... on Commit{oid statusCheckRollup{state}}}}}}}}'
    gh_read api graphql -f query="$query" -F owner="$owner" \
      --jq '.data.repositoryOwner.repositories.nodes' > "$output_file" || \
      die "failed to list repositories for owner $owner"
    owner_files+=("$output_file")
    ((owner_index += 1))
  done < <(jq -r '.owners | keys[]' "$POLICY_PATH")

  jq -s 'add | sort_by(.nameWithOwner)' "${owner_files[@]}" > "$TASK_TMP_DIR/live-repositories.json"

  while IFS= read -r encoded; do
    output_file="$TASK_TMP_DIR/live-repository-$job_index.json"
    collect_live_repo "$encoded" > "$output_file" &
    BATCH_PIDS+=("$!")
    ((job_index += 1))
    # Twenty-four workers keep the 64-repository audit below normal task-runner
    # execution windows while remaining below GitHub's REST concurrency limit
    # and the authenticated rate budget.
    if ((${#BATCH_PIDS[@]} >= 24)); then
      wait_for_batch
    fi
  done < <(jq -r '.[] | @base64' "$TASK_TMP_DIR/live-repositories.json")
  ((${#BATCH_PIDS[@]} == 0)) || wait_for_batch

  jq -s 'sort_by(.nameWithOwner)' "$TASK_TMP_DIR"/live-repository-*.json
}

if [[ "$MODE" == "fixture" ]]; then
  normalize_fixture > "$RAW_PATH"
else
  collect_live > "$RAW_PATH"
fi

raw_record_is_valid='def valid:
  (.nameWithOwner | type == "string") and
  (.nameWithOwner | test("^[^/]+/[^/]+$")) and
  (.isFork | type == "boolean") and
  (.isArchived | type == "boolean") and
  (.isPrivate | type == "boolean") and
  (.paths | type == "array");'

if ! jq -e "$raw_record_is_valid type == \"array\" and all(.[]; valid)" "$RAW_PATH" >/dev/null; then
  jq "$raw_record_is_valid {
    recordCount: (if type == \"array\" then length else null end),
    invalid: (if type == \"array\" then [to_entries[] | select(.value | valid | not) | {
      index: .key,
      nameType: (.value.nameWithOwner | type),
      namePatternValid: (.value.nameWithOwner | type == \"string\" and test(\"^[^/]+/[^/]+$\")),
      forkType: (.value.isFork | type),
      archivedType: (.value.isArchived | type),
      privateType: (.value.isPrivate | type),
      pathsType: (.value.paths | type)
    }] else [] end)
  }" "$RAW_PATH" >&2
  die "repository metadata failed the shape gate"
fi

jq -n \
  --slurpfile policyDocument "$POLICY_PATH" \
  --slurpfile repositoryDocument "$RAW_PATH" \
  --arg observedAt "$OBSERVED_AT" \
  --arg mode "$MODE" '
  ($policyDocument[0]) as $policy |
  ($repositoryDocument[0]) as $repositories |
  def repo_owner($repo): $repo.nameWithOwner | split("/")[0];
  def known_owner($policy; $repo): (repo_owner($repo) as $owner | $policy.owners | has($owner));
  def is_active_owned($policy; $repo): known_owner($policy; $repo) and ($repo.isFork | not) and ($repo.isArchived | not);
  def is_platform($policy; $repo): any($policy.platformRepositories[]; . == $repo.nameWithOwner);
  def is_in_scope($policy; $repo): is_active_owned($policy; $repo) and (is_platform($policy; $repo) | not);
  def disposition($policy; $repo):
    if (known_owner($policy; $repo) | not) then "excluded_unknown_owner"
    elif $repo.isFork then "excluded_fork"
    elif $repo.isArchived then "excluded_archived"
    elif is_platform($policy; $repo) then "platform"
    else "in_scope"
    end;
  def denial_reason($policy; $repo):
    if (known_owner($policy; $repo) | not) then "unknown_owner"
    elif $repo.isFork then "fork"
    elif $repo.isArchived then "archived"
    else null
    end;
  def stack:
    .paths as $paths |
    [
      (if any($paths[]; . == "package.json") then "node" else empty end),
      (if any($paths[]; . == "pnpm-workspace.yaml" or . == "turbo.json") then "node-monorepo" else empty end),
      (if any($paths[]; . == "pyproject.toml" or . == "setup.py" or . == "requirements.txt" or . == "Pipfile") then "python" else empty end),
      (if any($paths[]; . == "composer.json") then "php" else empty end),
      (if any($paths[]; . == "pubspec.yaml") then "flutter" else empty end),
      (if any($paths[]; . == "go.mod") then "go" else empty end),
      (if any($paths[]; . == "pom.xml" or . == "build.gradle" or . == "build.gradle.kts") then "jvm" else empty end),
      (if any($paths[]; . == "Cargo.toml") then "rust" else empty end),
      (if any($paths[]; . == "wp-content" or startswith("wp-content/")) then "wordpress" else empty end)
    ] | unique;
  def providers:
    .paths as $paths |
    [
      (if any($paths[]; . == "vercel.json") then "vercel" else empty end),
      (if any($paths[]; . == "render.yaml") then "render" else empty end),
      (if any($paths[]; . == "Dockerfile" or endswith("/Dockerfile") or . == "docker-compose.yml" or . == "compose.yaml") then "docker" else empty end),
      (if any($paths[]; . == ".do/app.yaml") then "digitalocean-app" else empty end),
      (if any($paths[]; . == "coolify.yaml") then "coolify" else empty end)
    ] | unique;
  def health:
    if .defaultBranchStatus == "SUCCESS" then "green"
    elif (.defaultBranchStatus == "FAILURE" or .defaultBranchStatus == "ERROR") then "red"
    elif (.defaultBranchStatus == "PENDING" or .defaultBranchStatus == "EXPECTED") then "pending"
    elif .latestWorkflow == null and ([.paths[] | select(startswith(".github/workflows/"))] | length) == 0 then "no_runs"
    elif .latestWorkflow == null then "unknown"
    elif .latestWorkflow.status != "completed" then "pending"
    elif .latestWorkflow.headSha != .defaultBranchHeadSha then "stale"
    elif .latestWorkflow.conclusion == "success" then "green"
    else "red"
    end;

  ($repositories | map(
    . as $repo |
    (repo_owner($repo)) as $owner |
    (is_in_scope($policy; $repo)) as $inScope |
    (is_active_owned($policy; $repo)) as $activeOwned |
    {
      nameWithOwner,
      owner: $owner,
      isFork,
      isArchived,
      isPrivate,
      defaultBranch,
      defaultBranchHeadSha,
      pushedAt,
      primaryLanguage,
      disposition: disposition($policy; $repo),
      mutationAllowed: $activeOwned,
      mutationDeniedReason: denial_reason($policy; $repo),
      paperclipCompany: (if ($policy.owners | has($owner)) then $policy.owners[$owner].paperclipCompany else null end),
      profile: (if ($inScope | not) then null elif .defaultBranch == "dev" then "major" else "fast" end),
      branchNormalizationRequired: ($inScope and (.defaultBranch != "main" and .defaultBranch != "dev")),
      stack: stack,
      providerIndicators: providers,
      workflowFiles: ([.paths[] | select(startswith(".github/workflows/"))] | length),
      deliveryEntrypoints: {
        script: any(.paths[]; . == "scripts/delivery"),
        paperclipProject: any(.paths[]; . == ".paperclip/project.yaml"),
        deliveryContract: any(.paths[]; . == ".flama/delivery-contract.json"),
        productionManifest: any(.paths[]; . == ".deploy/production.yaml")
      },
      defaultBranchStatus,
      latestWorkflow,
      health: (if $activeOwned then health else "inventory_only" end)
    }
  ) | sort_by(.nameWithOwner)) as $classified |

  ($classified | group_by(.owner) | map({
    key: .[0].owner,
    value: {
      expected: $policy.owners[.[0].owner].expected,
      observed: {
        inScope: ([.[] | select(.disposition == "in_scope")] | length),
        private: ([.[] | select(.disposition == "in_scope" and .isPrivate)] | length),
        public: ([.[] | select(.disposition == "in_scope" and (.isPrivate | not))] | length),
        forks: ([.[] | select(.isFork)] | length),
        archived: ([.[] | select(.isArchived)] | length)
      }
    }
  }) | from_entries) as $owners |

  {
    schemaVersion: 1,
    observedAt: $observedAt,
    source: {mode: $mode},
    policyVersion: $policy.version,
    summary: {
      total: ($classified | length),
      inScope: ([$classified[] | select(.disposition == "in_scope")] | length),
      private: ([$classified[] | select(.disposition == "in_scope" and .isPrivate)] | length),
      public: ([$classified[] | select(.disposition == "in_scope" and (.isPrivate | not))] | length),
      forks: ([$classified[] | select(.isFork)] | length),
      archived: ([$classified[] | select(.isArchived)] | length),
      platform: ([$classified[] | select(.disposition == "platform")] | length),
      mutationAllowed: ([$classified[] | select(.mutationAllowed)] | length),
      mutationDenied: ([$classified[] | select(.mutationAllowed | not)] | length)
    },
    owners: $owners,
    repositories: $classified
  }
' > "$RESULT_PATH"

if ! jq -e '
  all(.owners[]; .expected == .observed) and
  ([.repositories[] | select((.isFork or .isArchived) and .mutationAllowed)] | length) == 0
' "$RESULT_PATH" >/dev/null; then
  jq '{owners,summary}' "$RESULT_PATH" >&2
  die "observed inventory does not match approved scope policy"
fi

OUTPUT_DIR=$(dirname "$OUTPUT_PATH")
[[ -d "$OUTPUT_DIR" ]] || die "output directory does not exist: $OUTPUT_DIR"
cp "$RESULT_PATH" "$OUTPUT_PATH"
printf 'wrote %s (%s in scope; %s denied mutation)\n' \
  "$OUTPUT_PATH" \
  "$(jq -r '.summary.inScope' "$RESULT_PATH")" \
  "$(jq -r '.summary.mutationDenied' "$RESULT_PATH")"
