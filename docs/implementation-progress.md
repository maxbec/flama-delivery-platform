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
| 2 — Paperclip foundation | In progress | Shared skill and enforced lifecycles are installed. Two company controllers are paused and zero-budget; one controller remains behind native board approval. Authoritative project/workspace bindings and live routines/bridge deployment are pending. |
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
- Hosted Foundation Gate: [run 30530049431](https://github.com/maxbec/flama-delivery-platform/actions/runs/30530049431), passed for that exact baseline
- Runtime: Node.js `26.3.0`
- Released Paperclip dependency used as-is: `2026.722.0`
- Local full gate: passed with 196 unit tests and 12 PostgreSQL 18 Testcontainers integration tests
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

## Phase 2 live checkpoint

Verified before the current re-audit:

- the shared `flama-paperclip-delivery` skill was installed from pinned,
  content-verified source across the eligible agent scope;
- the three canonical enforced lifecycle pipelines were installed and read back
  without managed drift;
- two company-local controllers were created/reused as paused, zero-budget
  process agents; and
- the remaining controller hire request was left behind Paperclip's native
  human board-approval boundary.

Still pending:

- completion of the temporary operator re-audit through Paperclip's documented
  CLI;
- native approval of the remaining company controller;
- authoritative selection of project/workspace mappings for every consumer;
- creation of private repository bindings from those mappings;
- deterministic installation of both paused routine types;
- direct, non-logging capture of generated routine HMAC material into the exact
  Infisical project/environment/path mapping;
- bridge deployment, scoped authorization writes, controlled routine
  activation, replay verification, and native governance attestations; and
- the later GitHub App identities needed for authoritative missed-event
  discovery and governance aggregation.

The scheduled reconciliation installer is implemented. The GitHub-transition
routine contract, native execution path, HMAC publisher, and artifact boundary
are implemented, but the deterministic live installer still needs its
Infisical receipt/capture path before the webhook trigger may be created. This
gap was found during the current checkpoint and is being closed before any live
routine mutation.

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

1. Complete the temporary read-only Paperclip re-audit and revoke the temporary
   operator credential when the audit is finished.
2. Finish and test the Infisical-safe GitHub-transition routine installer
   without creating a live trigger.
3. Obtain the remaining native controller approval and authoritative private
   project/workspace mappings.
4. Apply both routine types paused, using canary-first provisioning and private
   identifier-free evidence.
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
