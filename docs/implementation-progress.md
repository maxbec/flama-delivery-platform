# Flama delivery-platform implementation progress

Last updated: 2026-07-30

This is the public-safe implementation checkpoint for the approved delivery
plan. Private repository names, Paperclip object
identifiers, project/workspace mappings, credentials, webhook URLs, secret
values, and raw API responses remain outside this public repository.

## Executive status

| Phase | Status | Current evidence |
| --- | --- | --- |
| 0 — Authoritative inventory | Corrected and complete | **The approved scope named the wrong GitHub owner.** The Edilio company's owner was recorded as a personal account of the same name belonging to an unrelated person, which put 38 third-party repositories in scope. The real owner is the organization `edilio-app`, which holds 2 repositories. In-scope consumers are therefore **28**, not 64: 15 maxbec, 11 navigaite, 2 edilio-app. No third-party repository was ever modified — the platform had only read them — but every downstream artifact built on the wrong scope was rebuilt. The inventory also no longer emits its own branch profile: it duplicated the rule in `jq` as a default-branch heuristic and disagreed with `classify` on deploying repositories, so `classify` is now the single profile authority. |
| 1 — Platform foundation | Implemented for the current deployment surface; two gaps open, both outside code | Node.js 26 platform, deterministic CLI, reusable workflows, schemas, policies, bridge, controller, governance job, release builder, and test harness are implemented and green. Open gaps, listed under known platform gaps: the GitHub repair apply path, which needs the Phase 3 owner-scoped App, and the three runner classes, which are infrastructure. Deployment adapter coverage is complete for the providers actually in use. Operator-initiated rollback is now a first-class deterministic command alongside automatic in-deployment rollback. Pooled-budget caching is enforced with the untrusted-lane write ban, and the pooled cache-hit rate is now read from run metadata. Publishing an immutable release remains gated on the scoped release identity. |
| 2 — Paperclip foundation | In progress | Shared skill and enforced lifecycles are installed and were re-read through the documented CLI. The HMAC routine installer and secret-safe Infisical receipt path are implemented locally. All three company controllers are now migrated onto the immutable release entrypoint and verified paused, zero-budget, and topology-v2 through an independent control-plane read; the installer is idempotent. All 28 in-scope repositories now have a Paperclip project, workspace, and an active private binding in a dedicated delivery database. The 38 projects, workspaces, and bindings created under the wrong owner were removed, and a migration corrects the owner in the database constraints. Live routines and bridge deployment are pending. |
| 3 — GitHub and Infisical policy | Auditing now runnable; live configuration pending | Metadata-only policy auditors exist, and the missing observation producer is implemented: a read-only observer builds the audit input from GitHub metadata and fails closed on any owner absent from the approved App/runner posture. A sweep of all 22 repositories the contract can currently see — every owner, no refusals — returns real, reproducible drift: none is compliant yet, and the most common gaps are required checks, branch protection, Actions trust policy, and the deployment review boundary. The declared owner-scoped App and runner posture now passes, so no App or runner finding is raised. Observation needs an owner-level credential, because reading the Actions policy requires admin or the fine-grained Actions-policies permission, which the delivery App deliberately does not hold. Scoped GitHub Apps, exact Infisical mappings, OIDC/Sync verification, runner separation, settings changes, and any exception approval are not yet applied. |
| 4 — Canaries | Planning and audit gates implemented; live run pending | Deterministic coverage and evidence gates exist, but no real canary repository has been selected or changed. |
| 5 — Migration waves | Not started | No consumer repository has been migrated. |
| 6 — Completion audit | Not started | The required 28/28 audit, rollback/replay drills, pooled-usage proof, and v3 retirement remain pending. |

The legacy v3 implementation remains in place. No fork or archived repository
has been changed, and no consumer migration starts before representative
canaries pass.

## Current public foundation evidence

- Repository: `maxbec/flama-delivery-platform`
- Working branch: `agent/platform-foundation`
- Draft pull request: [#1](https://github.com/maxbec/flama-delivery-platform/pull/1)
- Foundation implementation baseline: signed commit `50e7c8fa12e0930402d1a652a5d407d65dcb802e`
- Secret-safe HMAC routine installer checkpoint: signed commit
  `5972f4f661bac8906305aa19d5478ca107459c63`
- Provider, policy, and caching checkpoint: signed commits
  `a5d9802` and `080a732`
- Hosted Foundation Gate:
  [run 30544500328](https://github.com/maxbec/flama-delivery-platform/actions/runs/30544500328),
  passed for signed commit `080a732`
- Runtime: Node.js `26.3.0`
- Released Paperclip dependency used as-is: `2026.722.0`
- Current local full gate: passed with 381 unit tests and 12 PostgreSQL 18
  Testcontainers integration tests
- Deterministic CLI, bridge, company-controller, governance, and complete platform-release bundles: reproducible
- Public-repository audit: passed

The branch is synchronized with its remote and the draft PR remains unmerged.
No platform release, consumer change, production deployment, billing change, or
secret migration is implied by a green foundation gate.

## Paperclip authority model

Paperclip is the control plane and lifecycle authority. It does not need a
read-only account to access itself, and no such account is part of the design.

The implemented event path is:

```text
GitHub webhook
→ Flama bridge validates, minimizes, durably queues, and authorizes the event
→ bridge signs one exact Paperclip public routine-trigger request
→ Paperclip creates the native routine run
→ company Delivery Controller executes under Paperclip's current run identity
→ controller revalidates authorization, binding, lifecycle edge, stage, and version
→ Paperclip performs the case transition
```

Consequently:

- the bridge has no Paperclip human account, Viewer account, board token, agent
  API key, task-bridge credential, or case API access;
- direct case API code exists only in the native company-controller executable;
- the bridge release test rejects `PAPERCLIP_API_KEY` and `/api/cases/` in its
  bundle;
- the controller records publication only after the exact native transition;
- governance consumes digest-bound attestations from native company-controller
  runs and does not poll Paperclip with a cross-company credential; and
- the released Paperclip package is neither edited, patched, vendored, forked,
  submoduled, nor copied into this repository.

The routine-trigger HMAC secret is an external trigger credential. It must be
captured directly into the authoritative Infisical mapping and injected into
the bridge at runtime; it must never appear in source, CLI arguments, logs,
evidence, artifacts, or this document.

Released Paperclip necessarily retains its generated verifier copy. A live
trigger therefore also requires a current machine-readable
`provider_native_secret` exception. This narrow exception does not make
Paperclip a reader account or secret source: Infisical remains the runtime
delivery source for the bridge, and the installer verifies only non-secret
receipt metadata on reruns.

## Phase 2 live checkpoint

The temporary read-only re-audit is complete:

- every eligible agent has the `flama-paperclip-delivery` skill in Paperclip's
  desired state; ordinary adapters report synchronization support, while
  process adapters retain the desired assignment without claiming unsupported
  runtime synchronization;
- every managed lifecycle pipeline in the approved company scope exactly
  matches its versioned stages, enforced edges, and cancellation sentinel;
- the company controller records remain zero-budget with agent/skill/assignment
  creation denied. Two are paused, and the third hire was approved by the board on
  2026-07-30. Its entrypoint migration and pause are still to be applied live;
- all controller records still point to the exact legacy source entrypoint.
  Their existing executables are present, but migration to the immutable
  release entrypoint has not been performed or silently inferred. The
  fail-closed migration path itself is implemented and tested; only its live
  application is outstanding;
- no managed routine has been applied, and the available project/workspace
  configuration is insufficient to infer authoritative repository bindings;
  and
- the temporary administrator CLI token used for this audit was revoked and
  removed locally after the readback. No live Paperclip mutation was made.

The repository now implements the missing GitHub-transition installer. It:

- defaults to identity-free dry-run and always creates the routine paused;
- validates the exact active company, paused zero-budget controller, selected
  project, HMAC contract, Infisical mapping, and current secret-storage
  exception before a live write;
- captures Paperclip's one-time webhook URL and secret in memory only, then
  upserts the exact bridge keys to Infisical using a short-lived injected token;
- never reads Infisical secret values on rerun, instead comparing trigger-bound
  receipt metadata requested with `viewSecretValue=false`;
- reuses an exact receipt and rotates once to recover a missing or partial
  two-secret handoff or to enforce the approved rotation interval; and
- emits only planned/applied dispositions, synchronization state, and contract
  and exception digests. It omits IDs, URLs, paths, timestamps, and values.

Still pending:

- native approval of the remaining company controller;
- fail-closed migration of the approved controllers from the exact legacy
  source entrypoint to the immutable release entrypoint;
- authoritative selection of project/workspace mappings for every consumer;
- creation of private repository bindings from those mappings;
- deterministic installation of both paused routine types;
- approval of the exact Paperclip verifier-copy exception and private
  Infisical project/environment/path mappings required before HMAC trigger
  creation;
- bridge deployment, scoped authorization writes, controlled routine
  activation, replay verification, and native governance attestations; and
- the later GitHub App identities needed for authoritative missed-event
  discovery and governance aggregation.

Both deterministic routine installers are implemented. Neither routine has
been applied live. The scheduled routine still requires its authoritative
project selection; the HMAC routine additionally requires the exact Infisical
mapping and current Paperclip verifier-copy exception. Activation remains a
separate, explicit production decision after bridge deployment and canary
evidence.

## Known platform gaps outside the live gates

- Plan section 8 caching is now implemented for the platform's own CI with the
  section 16 lane split enforced: restore in every lane, save only from a
  protected default-branch push, split cache actions pinned to one SHA, and a
  key carrying the trust boundary, OS, runtime, and lockfile inputs. The
  Governance Controller now derives the pooled cache-hit rate from a marker step
  read through the jobs API instead of returning a hardcoded value. Consumer
  repositories install through the repository-owned `./scripts/delivery`
  entrypoint, so their caches and marker steps arrive with the generated callers
  in the migration waves; until then consumer coverage is reported as
  `not_emitted`, which is accurate rather than a placeholder. Turbo/Next.js and
  Docker layer caches remain unimplemented and belong with the consumer stacks
  they serve. See [pooled compute budget caching](operations/pooled-cache.md).
- Plan section 14 names eight deployment providers. Five are now implemented as
  platform builtins and selected automatically from repository-owned
  `provider.parameters` when no `--adapter` path is supplied: `docker-compose` on a
  local Docker endpoint, `digitalocean-droplet` and `hostinger-vps` on an SSH-only
  remote endpoint, `vercel-prebuilt` uploading prebuilt output with REST
  read-back verification, and `digitalocean-app` pinning the app spec to an exact
  digest with published-phase verification. `coolify` and `render` are confirmed out of scope: the owner does not deploy
  to either today, and plan section 14 introduces its provider list with "supported
  adapters begin with", so an unused provider is not a required adapter. Builtin
  coverage is complete for the current deployment surface. Both keep refusing with
  `adapter_not_implemented` so an accidental manifest naming one cannot deploy
  through an unverified path. Neither publishes a declared set of terminal
  deployment states, which is the blocker to resolve first if either becomes a
  target.
  `custom` stays repository-supplied by definition. See
  [deployment provider adapters](operations/deployment-providers.md).
- Plan section 17's repair classification is now implemented as
  `flama-delivery-ctl github-policy-repair`. It splits audit findings into safe
  reversible repairs and Paperclip remediation cases: only settings that tighten a
  reversible repository value are auto-repairable, while a default-branch or
  protected-branch-set change (breaks existing clones and open pull requests), a
  GitHub App scope change (external identity), runner separation (infrastructure),
  and the deployment review boundary (repository-owned CODEOWNERS content) always
  become remediation cases. A fork, an archived repository, or an invalid contract
  denies the whole plan, and an unrecognized finding is treated as destructive
  rather than assumed safe. Applying a plan still refuses with
  `repair_apply_unavailable`: it needs the Phase 3 owner-scoped GitHub App, and each
  setting's exact endpoint must be confirmed before it is written.
- Plan section 20 is now implemented as one deterministic decision point,
  `flama-delivery-ctl failure-policy`: at most one jittered retry and only for a
  recognized transient cause or a flake, no retry for a deterministic failure or a
  deployment health failure, always-recorded stabilization tasks, deduplicated
  incidents that pause the release path, fail-closed secret-exposure handling with
  credential rotation, and owner notification restricted to the conditions the plan
  lists. See [failure and recovery policy](operations/failure-policy.md).
- Plan section 16 requires three runner classes, including a separate hardened
  deployment runner. Every job currently runs on `ubuntu-latest`, including the
  reusable deploy workflow.
- Plan section 9's `compliance` and `usage` verbs now exist as projections of the
  governance controller's validated result, so no threshold or rule is computed
  twice. Compliance status is derived from the Paperclip dimensions alone, because a
  slow pipeline is a budget matter rather than a compliance breach. Usage compares
  pooled percentiles against `policies/ci-budget.json` and reports a profile with no
  samples as unmeasured rather than compliant.
- Plan section 21 phase 6 drill scripts now exist: `scripts/drill-rollback.sh` and
  `scripts/drill-event-replay.mjs`. Both exercise real recovery rather than fakes,
  so both refuse every unauthorized or under-specified invocation, and the rollback
  drill refuses an input that is not marked as a drill. CI proves those refusals and
  their reasons; it does not run the drills, because they need infrastructure a
  public runner does not have. **No drill has been performed**: a green gate is not
  drill evidence, and phase 6 remains not started. See
  [recovery drills](operations/recovery-drills.md).

## Secret and public-repository safety

- Infisical remains the default and authoritative secret source.
- No secret value is accepted by metadata-only audit schemas or written to
  repository evidence.
- Live inventory and mapping evidence stays in protected mode-`0600` storage
  outside the checkout.
- Public PR code receives no secrets, OIDC, trusted cache writes, private
  runners, or production network access.
- GitHub credentials are restricted to scoped App installation-token forms;
  personal access token forms are rejected by platform runtime boundaries.
- Routine, API, and verifier error bodies are suppressed.
- Ordinary controller, bridge, reconciliation, and governance output is
  identifier-minimized and digest-based.
- A live destination secret that cannot remain Infisical-authoritative requires
  a current, explicitly approved machine-readable exception.

No one-time CLI-auth link or token is recorded here. Loopback access for the
current SSH-tunneled operator audit was enabled through Paperclip's documented
hostname configuration and the service returned healthy after its required
restart.

## Next gates

1. Finish the local and hosted gates for the Infisical-safe GitHub-transition
   routine installer without creating a live trigger.
2. Obtain the remaining native controller approval and migrate approved
   controllers to the immutable release entrypoint.
3. Obtain authoritative private project/workspace mappings.
4. Approve the narrow verifier-copy exception, then apply both routine types
   paused using canary-first provisioning and private identifier-free evidence.
5. Configure scoped GitHub Apps and exact Infisical mappings only after their
   authority and secret exception state are confirmed.
6. Select and execute the representative Phase 4 canaries before changing any
   wider consumer set.
7. Migrate three to five consumers per wave, stopping if the same platform
   defect appears twice.
8. Prove every completion criterion across all 28 consumers before retiring
   the legacy v3 implementation.

## Evidence index

- [Phase 0 inventory evidence](evidence/phase-0.md)
- [Phase 1 runtime evidence](evidence/phase-1-runtime.md)
- [Phase 2 Paperclip evidence](evidence/phase-2-paperclip.md)
- [Phase 3 policy evidence](evidence/phase-3-policy.md)
- [Phase 4 canary evidence](evidence/phase-4-canaries.md)
- [Architecture](architecture.md)
- [Operator-initiated rollback](operations/rollback.md)
- [Pooled compute budget caching](operations/pooled-cache.md)
- [Deployment provider adapters](operations/deployment-providers.md)
- [Failure and recovery policy](operations/failure-policy.md)
- [Recovery drills](operations/recovery-drills.md)

This checkpoint is implementation evidence only. It authorizes no production
deployment, billing change, new external identity, secret publication, or
consumer rollout.
