# Flama Preflight check publication

Every feature pull request head needs a `Flama Preflight` check authored by the
owner's Flama delivery GitHub App (`flama-delivery-maxbec`,
`flama-delivery-navigaite`, `flama-delivery-edilio`). It attests that
`./scripts/delivery buildable` followed by `./scripts/delivery affected` exited
zero on a clean checkout of exactly that commit, observed by the platform's
preflight harness. The policy gate judges it, the merge gate and the
required-check rule hold the merge for it, and the push guard raises an alarm
when a commit reaches the stable branch without it.

The check was called `Paperclip Preflight` while its only publisher was a sweep
on ai-vm, Paperclip's machine. That coupling took the whole fleet down with the
machine (2026-08-29: `paperclipai.service` stopped, the sweep timers with it,
and every policy gate timed out). The pipeline must not depend on Paperclip;
Paperclip depends on the pipeline. The check is therefore published from inside
GitHub now, and the sweep is an optional accelerator.

## Publishers

| Publisher | Where | When | Runs the commands as |
| --- | --- | --- | --- |
| `flama-preflight.yml` (generated) → `reusable-preflight.yml` | The consumer's own GitHub Actions, on its runner labels | On every completed Branch Guard of a same-repository pull request against the feature target | `runner.class: github_actions`, `runner.id: <run id>` |
| `flama-delivery-ctl sweep` (`flama-sweep@<org>.timer` on ai-vm) | ai-vm | Every two minutes after the previous pass, when the machine is up | `runner.class: paperclip_ephemeral` |

Both publish as the same App with the same evidence contract, so the gates do
not care which one got there first. They do not build a head twice: the
workflow announces its check as `in_progress` before it builds, and the sweep
leaves any head alone that already carries an App-authored `Flama Preflight`
in any state; the sweep, in turn, yields at publication when it finds a check
the workflow has announced meanwhile.

## The Actions publisher

`reusable-preflight.yml` is called from the default branch on `workflow_run`
completion of the Branch Guard, which is what makes its definition trusted: a
pull request cannot rewrite the publisher that judges it. It is three jobs on
the consumer's runner labels:

1. **Scope** — finds the open pull request the head is the tip of (same
   repository, feature target), stands down if the head already carries a
   successful App-authored check, mints a repository-scoped `checks: write` App
   token and announces `Flama Preflight` as in progress with a link to the run.
   Never checks out code.
2. **Run** — checks out the exact head and the exact platform commit, obtains
   the platform CLI (`scripts/obtain-cli.sh`: the released bundle for the
   pinned tag, checksum- and manifest-verified) and runs
   `flama-delivery-ctl preflight`. Holds no secret; its token can read and
   nothing else. This is the only job that executes consumer code.
3. **Publish** — on success, `certify` then `publish-check`, completing the
   announced check in place; on failure, completes it as `failure` with the
   failing command and a link to the run. Checks out nothing but the platform.

The App credential reaches the workflow as the repository or organisation
secrets `FLAMA_APP_ID` and `FLAMA_APP_PRIVATE_KEY`, forwarded by name by the
generated caller — the same pattern as `WORKFLOW_APP_*` for the merge. Blanket
`secrets: inherit` stays forbidden. Where the pair is missing the Scope job
fails with a message rather than building for nothing.

A `workflow_run`-started run is attached to the default branch, not the pull
request, so the run itself is not on the pull request's checks tab. The
announced App check is: in progress with the link, then the verdict.

## The policy gate no longer waits

The policy gate used to poll for the preflight for up to 35 minutes, holding a
runner while it did. With the publisher on the same runner pool that is a
deadlock on one runner and a queue on two. The gate now judges a completed
preflight — a failure fails it at once — and leaves an absent or running one
to the merge gate and the required-check rule, both of which refuse a head
without a successful App-authored check and re-evaluate the moment it lands.
Nothing merges on the policy gate's word alone.

## The CLI commands

`preflight --input <run-input> --output <run-result>` runs the two commands in
the working directory, which must be a clean checkout at `headSha`. The input
may name `runnerClass` (`paperclip_ephemeral` by default, `github_actions` from
the workflow). The result is unsigned.

`certify --input <run + controller + appSlug + runnerId + signedAt> --output
<evidence>` attests a passing run. It refuses a failing run, a signature
predating the run, and a controller that does not own the repository.

`publish-check --input <publication>` validates the canonical evidence digest,
the exact command sequence, the owner/controller binding and the single-
repository token scope, then creates the completed check — or, when the input
names `pendingCheckRunId`, completes that announced check in place. The token
enters only as `FLAMA_GITHUB_APP_INSTALLATION_TOKEN` in the process
environment; never in the input, command line, file, log, artifact or summary.
Repeated publication of the same evidence reuses the identical existing check.
A conflicting digest, an announced check that is not this App's, or a check
another publisher has announced meanwhile fails closed. The command does not
retry and never reads or prints a GitHub error body.

Plan without an identity or a network call:

```bash
flama-delivery-ctl publish-check --dry-run --input /protected/evidence/publish-check.json
```

## Transition from `Paperclip Preflight`

Consumers pinned to a platform older than the rename still look for a check
called `Paperclip Preflight`. Until every consumer is re-rendered, the sweep is
run with `"publishLegacyCheck": true` and publishes both names with the same
digest, so the re-rendering pull requests merge through the older merge gate
they were opened under. Branch-protection rules that name
`Paperclip Preflight` as a required context must be renamed when the
repository is re-rendered; `policies/branch-profiles.json` names the new
context. The legacy publication is removed with the last consumer.

- <https://docs.github.com/en/rest/checks/runs>
- <https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation>
- <https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#workflow_run>
