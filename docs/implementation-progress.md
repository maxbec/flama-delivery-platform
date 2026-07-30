# Flama delivery-platform implementation progress

Last updated: 2026-07-30

This is the public-safe implementation checkpoint for the approved delivery
plan. Private repository names, Paperclip object
identifiers, project/workspace mappings, credentials, webhook URLs, secret
values, and raw API responses remain outside this public repository.

## Executive status

| Phase | Status | Current evidence |
| --- | --- | --- |
| 0 — Authoritative inventory | Complete | Fresh inventory proves 64 owned, non-fork, non-archived consumers; 28 forks and 3 archived repositories are mutation-denied. |
| 1 — Platform foundation | Foundation implementation complete | Node.js 26 platform, deterministic CLI, reusable workflows, schemas, policies, bridge, controller, governance job, release builder, and test harness are implemented and green. Publishing an immutable release remains gated on the scoped release identity. |
| 2 — Paperclip foundation | In progress | Shared skill and enforced lifecycles are installed and were re-read through the documented CLI. The HMAC routine installer and secret-safe Infisical receipt path are implemented locally. Two company controllers are paused and zero-budget; one remains behind native board approval. Immutable controller migration, authoritative project/workspace bindings, and live routines/bridge deployment are pending. |
| 3 — GitHub and Infisical policy | Tooling implemented; live configuration pending | Metadata-only policy auditors exist. Scoped GitHub Apps, exact Infisical mappings, OIDC/Sync verification, runner separation, settings changes, and any exception approval are not yet applied. |
| 4 — Canaries | Planning and audit gates implemented; live run pending | Deterministic coverage and evidence gates exist, but no real canary repository has been selected or changed. |
| 5 — Migration waves | Not started | No consumer repository has been migrated. |
| 6 — Completion audit | Not started | The required 64/64 audit, rollback/replay drills, pooled-usage proof, and v3 retirement remain pending. |

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
- Hosted Foundation Gate:
  [run 30533863593](https://github.com/maxbec/flama-delivery-platform/actions/runs/30533863593),
  passed for that exact installer checkpoint
- Runtime: Node.js `26.3.0`
- Released Paperclip dependency used as-is: `2026.722.0`
- Current local full gate: passed with 205 unit tests and 12 PostgreSQL 18
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
  creation denied; two are paused and the remaining hire request is still
  behind Paperclip's human board-approval boundary;
- all controller records still point to the exact legacy source entrypoint.
  Their existing executables are present, but migration to the immutable
  release entrypoint has not been performed or silently inferred;
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
8. Prove every completion criterion across all 64 consumers before retiring
   the legacy v3 implementation.

## Evidence index

- [Phase 0 inventory evidence](evidence/phase-0.md)
- [Phase 1 runtime evidence](evidence/phase-1-runtime.md)
- [Phase 2 Paperclip evidence](evidence/phase-2-paperclip.md)
- [Phase 3 policy evidence](evidence/phase-3-policy.md)
- [Phase 4 canary evidence](evidence/phase-4-canaries.md)
- [Architecture](architecture.md)

This checkpoint is implementation evidence only. It authorizes no production
deployment, billing change, new external identity, secret publication, or
consumer rollout.
