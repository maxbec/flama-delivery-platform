---
name: flama-paperclip-delivery
description: Operate Flama software-delivery tasks through Paperclip and GitHub using exact-SHA evidence, generated platform entrypoints, company-scoped controllers, and fail-closed lifecycle transitions. Use for repository bootstrap, task readiness, preflight, pull-request progression, release/deployment cases, reconciliation, recovery, or compliance work in the maxbec, navigaite, and edilio delivery estate.
---

# Flama Paperclip Delivery

Apply the versioned Flama lifecycle without claiming externally verifiable state from agent judgment.

## Start safely

1. Resolve the repository from live inventory and confirm it is owned, non-fork, non-archived, and under `maxbec`, `navigaite`, or `edilio`.
2. Read the repository delivery contract, `.paperclip/project.yaml`, platform lock, task specification, and current GitHub state.
3. Work from the latest remote profile branch in one isolated worktree. Record the base SHA.
4. Stop if scope, company binding, platform version, or authority is missing or contradictory.
5. Never retrieve, print, copy, or place secret values in prompts, output, files, arguments, evidence, or caches. Use Infisical-mediated identities.

## Select the lifecycle

- Use `lifecycles/project-bootstrap.json` for intake through repository readiness.
- Use `lifecycles/feature-fix.json` for normal implementation work.
- Use `lifecycles/release-deployment.json` for release and production delivery.

Read [references/lifecycle-rules.md](references/lifecycle-rules.md) before advancing a state. Read [references/evidence.md](references/evidence.md) when producing or validating completion evidence.

## Execute deterministic gates

Invoke the pinned `flama-delivery-ctl` rather than reproducing its logic manually. Consumer validation uses only:

```text
./scripts/delivery buildable
./scripts/delivery affected
./scripts/delivery full
./scripts/delivery smoke
./scripts/delivery health
```

Run `buildable` and `affected` for preflight. Run `full` at the stable-branch/release boundary. Treat an unknown change detector result as broad impact. Never replace a missing command with a fake passing command.

## Respect authority

- Agents may advance internal Paperclip work states supported by task artifacts.
- The company Delivery Controller alone publishes exact-SHA preflight evidence and company transitions.
- Signed GitHub events alone prove PR open/merge, release, approval, deployment, and verification.
- Max alone authorizes production by approving the exact deployment PR head SHA.
- The Governance Controller is read-only across companies.
- No normal actor bypasses protection, force-pushes protected branches, approves production, or handles secret values.

If the SHA changes, invalidate prior preflight and approval evidence and rerun the applicable lifecycle step.

## Handle failure

- Do not retry deterministic build or test failures. Create or update a repair task.
- Retry a recognized transient infrastructure failure once with jitter.
- Retry only the failed test once when diagnosing a flake; record the flake and create stabilization work.
- Roll back a failed production verification once. Do not redeploy in a loop.
- Dead-letter exhausted bridge transitions using reason codes without payload or secret data.
- Notify Max only for the escalation conditions in [references/lifecycle-rules.md](references/lifecycle-rules.md).

## Finish

Re-fetch external state and reconcile it against the exact repository and SHA. Record structured evidence, keep the worktree clean, and leave the Paperclip case open when live deployment verification is part of the task and has not occurred.
