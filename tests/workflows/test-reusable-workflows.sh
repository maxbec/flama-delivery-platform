#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
POLICY="$ROOT_DIR/.github/workflows/reusable-policy.yml"
FINAL="$ROOT_DIR/.github/workflows/reusable-final.yml"
BRANCH_GUARD="$ROOT_DIR/.github/workflows/reusable-branch-guard.yml"

for workflow in "$BRANCH_GUARD" "$POLICY" "$FINAL"; do
  [[ -f "$workflow" ]] || { echo "missing reusable workflow" >&2; exit 1; }
  grep -Fqx 'permissions:' "$workflow"
  grep -Fqx '  contents: read' "$workflow"
  grep -Fq 'inputs.head-sha' "$workflow"
  if grep -Eq 'pull_request_target|id-token:|secrets:|continue-on-error:|secrets: inherit' "$workflow"; then
    echo "reusable workflow contains a forbidden trust or mutability pattern" >&2
    exit 1
  fi
  while IFS= read -r action_ref; do
    [[ "$action_ref" =~ ^[0-9a-f]{40}$ ]] || {
      echo "reusable workflow action is not pinned to a full SHA" >&2
      exit 1
    }
  done < <(sed -nE 's/^[[:space:]]*uses:[[:space:]]+[^@]+@([^[:space:]#]+).*/\1/p' "$workflow")
done

grep -Fqx '    name: Flama Branch Guard' "$BRANCH_GUARD"
grep -Fq 'github.event.pull_request.head.sha' "$BRANCH_GUARD"
for workflow in "$POLICY" "$FINAL"; do
  grep -Fq 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1' "$workflow"
  grep -Fqx '          persist-credentials: false' "$workflow"
done
grep -Fqx '    name: Flama Policy Gate' "$POLICY"
grep -Fqx '  checks: read' "$POLICY"
grep -Fq 'consumer-policy-gate.mjs' "$POLICY"
# The platform lock's semver was unverified free text: the gate compared it to
# the contract and the ref to its own input, and never asked whether the version
# is the tag at that commit. It can only answer that if the caller reads the tag
# from the platform repository and hands it over.
grep -Fq 'git ls-remote --tags https://github.com/maxbec/flama-delivery-platform.git' "$POLICY"
grep -Fq 'FLAMA_PLATFORM_TAG_VERSION: ${{ steps.platform-tag.outputs.version }}' "$POLICY"
grep -Fq '"$FLAMA_PLATFORM_TAG_VERSION" >/dev/null' "$POLICY"
grep -Fq 'check_name=Flama%20Preflight' "$POLICY"
grep -Fq 'flama-preflight:sha256:[0-9a-f]{64}' "$POLICY"
# The gate judges a completed preflight and never waits for one: a wait holds
# the runner slot the publisher needs, which deadlocks a single runner. A
# completed failure is a verdict and must fail immediately; absence is left
# to the merge gate and the required-check rule.
grep -Fq '.conclusion != "success"' "$POLICY"
if grep -Eq 'sleep [0-9]+|preflight-wait-seconds' "$POLICY"; then
  echo "policy workflow waits on a runner for the preflight" >&2
  exit 1
fi
grep -Fq "if: \${{ steps.change.outputs.mode == 'code' }}" "$POLICY"
grep -Fqx '          fetch-depth: 0' "$POLICY"
if grep -Eq './scripts/delivery (buildable|affected|full)' "$POLICY"; then
  echo "policy workflow duplicates application tests" >&2
  exit 1
fi
grep -Fqx '    name: Flama Final Gate' "$FINAL"
grep -Fqx '        run: ./scripts/delivery full' "$FINAL"
grep -Fq "if: \${{ steps.change.outputs.mode == 'code' }}" "$FINAL"
grep -Fq "if: \${{ steps.change.outputs.mode == 'deployment' }}" "$FINAL"
grep -Fq -- '--schema deployment-manifest' "$FINAL"
grep -Fqx '          fetch-depth: 0' "$FINAL"

# Arming auto-merge removes the human from a decision the gates already made,
# so it must never remove the human from cutting a release, promoting to the
# release branch, or finishing a draft. It arms only; GitHub still enforces
# every required check at merge time.
AUTO_MERGE="$ROOT_DIR/.github/workflows/reusable-auto-merge.yml"
[[ -f "$AUTO_MERGE" ]] || { echo "missing reusable auto-merge workflow" >&2; exit 1; }
grep -Fqx '    name: Flama Auto Merge' "$AUTO_MERGE"
grep -Fq -- '--squash --auto' "$AUTO_MERGE"
grep -Fq 'release-please--*' "$AUTO_MERGE"
grep -Fq 'reason=promotion' "$AUTO_MERGE"
grep -Fq 'reason=draft' "$AUTO_MERGE"
grep -Fqx '      pull-requests: write' "$AUTO_MERGE"
if grep -Eq 'pull_request_target|--admin|--force' "$AUTO_MERGE"; then
  echo "auto-merge workflow bypasses branch protection or trusts an untrusted event" >&2
  exit 1
fi
while IFS= read -r action_ref; do
  [[ "$action_ref" =~ ^[0-9a-f]{40}$ ]] || {
    echo "auto-merge workflow action is not pinned to a full SHA" >&2
    exit 1
  }
done < <(sed -nE 's/^[[:space:]]*uses:[[:space:]]+[^@]+@([^[:space:]#]+).*/\1/p' "$AUTO_MERGE")

# The identity that arms is the identity that merges, and a merge recorded as
# github-actions[bot] never starts push workflows on the base branch — the
# release and deploy runs after a self-merged pull request silently vanish.
# The workflow must therefore accept the optional App credential pair, mint an
# installation token from it, and use that token to arm; without the pair it
# falls back to the default token. The credential is safe here only because no
# step checks out or executes pull-request code, so that must stay true.
grep -Fqx '      WORKFLOW_APP_ID:' "$AUTO_MERGE"
grep -Fqx '      WORKFLOW_APP_PRIVATE_KEY:' "$AUTO_MERGE"
[[ $(grep -Fcx '        required: false' "$AUTO_MERGE") -ge 2 ]]
grep -Fq 'actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1' "$AUTO_MERGE"
# Two token steps exist because a head that rewrites .github/workflows/** needs
# workflows:write and an ordinary one must not get it. Whichever was minted,
# github.token stays the last resort — assert the whole chain rather than a
# fragment of it, so dropping a term cannot pass unnoticed.
grep -Fq 'steps.app-token.outputs.token || steps.app-token-workflows.outputs.token || github.token' "$AUTO_MERGE"
# The narrow token must stay narrow: only the workflows-capable step may ask
# for that permission, and it must ask for it exactly once.
[[ $(grep -Fc '          permission-workflows: write' "$AUTO_MERGE") -eq 1 ]]
grep -Fq 'WORKFLOW_APP_ID and WORKFLOW_APP_PRIVATE_KEY must be provided together' "$AUTO_MERGE"
if grep -Eq 'secrets: inherit|actions/checkout|continue-on-error:' "$AUTO_MERGE"; then
  echo "auto-merge workflow widens the credential surface it is allowed" >&2
  exit 1
fi

# The preflight publisher is the one reusable workflow that both executes the
# change and holds an App credential, and it may only do so in separate jobs:
# the job that checks out and runs consumer code gets no secret and a
# read-only token, and the job that holds the credential checks out nothing
# but the platform. It runs from the default branch via workflow_run, never
# via pull_request_target.
PREFLIGHT="$ROOT_DIR/.github/workflows/reusable-preflight.yml"
[[ -f "$PREFLIGHT" ]] || { echo "missing reusable preflight workflow" >&2; exit 1; }
grep -Fqx 'permissions:' "$PREFLIGHT"
grep -Fqx '  contents: read' "$PREFLIGHT"
grep -Fqx '  checks: read' "$PREFLIGHT"
grep -Fqx '    name: Flama Preflight Scope' "$PREFLIGHT"
grep -Fqx '    name: Flama Preflight Run' "$PREFLIGHT"
grep -Fqx '    name: Flama Preflight Publish' "$PREFLIGHT"
grep -Fqx '      FLAMA_APP_ID:' "$PREFLIGHT"
grep -Fqx '      FLAMA_APP_PRIVATE_KEY:' "$PREFLIGHT"
grep -Fq 'actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1' "$PREFLIGHT"
grep -Fq '          permission-checks: write' "$PREFLIGHT"
grep -Fq 'scripts/obtain-cli.sh' "$PREFLIGHT"
grep -Fq 'runnerClass: "github_actions"' "$PREFLIGHT"
grep -Fq 'FLAMA_GITHUB_APP_INSTALLATION_TOKEN: ${{ steps.app-token.outputs.token }}' "$PREFLIGHT"
grep -Fq "external_id=\"flama-preflight:pending:\$GITHUB_RUN_ID\"" "$PREFLIGHT"
grep -Fq "external_id=\"flama-preflight:failed:\$GITHUB_RUN_ID\"" "$PREFLIGHT"
# A cancelled or timed-out run must still complete the announced check, or it
# stays in progress and holds the merge with nothing left to wake it.
grep -Fq "if: \${{ always() && needs.resolve.outputs.proceed == 'true' }}" "$PREFLIGHT"
grep -Fq "(failure() || cancelled()) && needs.resolve.outputs.pending-check-run-id != ''" "$PREFLIGHT"
grep -Fq 'conclusion=cancelled' "$PREFLIGHT"
if grep -Eq 'pull_request_target|id-token:|secrets: inherit|continue-on-error:' "$PREFLIGHT"; then
  echo "preflight workflow contains a forbidden trust or mutability pattern" >&2
  exit 1
fi
while IFS= read -r action_ref; do
  [[ "$action_ref" =~ ^[0-9a-f]{40}$ ]] || {
    echo "preflight workflow action is not pinned to a full SHA" >&2
    exit 1
  }
done < <(sed -nE 's/^[[:space:]]*uses:[[:space:]]+[^@]+@([^[:space:]#]+).*/\1/p' "$PREFLIGHT")
# Job boundaries. The run job is the only one that checks out the consumer,
# and it must reference no secret; the publish job must check out nothing
# but the platform.
run_job=$(awk '/^  run:$/{p=1} /^  publish:$/{p=0} p' "$PREFLIGHT")
publish_job=$(awk '/^  publish:$/{p=1} p' "$PREFLIGHT")
resolve_job=$(awk '/^  resolve:$/{p=1} /^  run:$/{p=0} p' "$PREFLIGHT")
grep -Fq 'ref: ${{ inputs.head-sha }}' <<< "$run_job"
grep -Fqx '      contents: read' <<< "$run_job"
if grep -Eq 'secrets\.|app-token' <<< "$run_job"; then
  echo "preflight run job can reach a secret" >&2
  exit 1
fi
if grep -Fq 'ref: ${{ inputs.head-sha }}' <<< "$publish_job"; then
  echo "preflight publish job checks out the change under review" >&2
  exit 1
fi
if grep -Fq 'actions/checkout' <<< "$resolve_job"; then
  echo "preflight resolve job checks out code while holding the App credential" >&2
  exit 1
fi

echo "reusable workflow policy tests passed"
