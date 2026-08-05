# Phase 4 canary evidence

This checkpoint implements the deterministic planning and evidence gate for
representative canaries. It does not select a real repository, modify a
consumer, configure GitHub or Infisical, invoke Paperclip, merge or release a
change, request production approval, deploy an artifact, or perform rollback.

Implemented controls:

- A private plan must cover Fast and Major profiles, private and public
  visibility, one owned non-fork non-archived repository from each of `maxbec`,
  `navigaite`, and `edilio`, a legacy stack, a library release, Docker
  deployment, and managed-platform deployment.
- Every candidate is bound to the platform commit, inventory digest, exact
  source branch and SHA, and GitHub, Infisical, and Paperclip policy digests.
- Fast candidates require `main`; Major candidates require `dev`. Duplicate
  keys or repositories, owner mismatches, fork/archive state, malformed
  evidence, incomplete coverage, and conflicting deployment classifications
  fail closed.
- Planning accepts no evidence. Auditing requires evidence for every candidate
  and rejects evidence whose source SHA differs from the selected source SHA.
- Core proof requires preflight, auto-merge, secret isolation, event replay,
  and pooled-cost compliance for every candidate. Release, deployment approval,
  and rollback proofs are required for the candidates exercising those paths.
  The representative suite must also prove Infisical OIDC and Secret Sync.
- Public results contain aggregate coverage, aggregate proof states, stable
  finding codes, and plan/evidence digests only. Repository names, candidate
  keys, source SHAs, individual evidence digests, and private mappings are not
  returned.
- `canary-plan` and `canary-audit` are local, deterministic, non-mutating
  evaluators. The committed fixture is synthetic and is not a live selection.

Still pending:

- private selection of current candidate repositories from an authoritative
  fresh inventory;
- scoped identities, mappings, and approved exception state needed for live
  GitHub, Infisical, and Paperclip evidence collection;
- explicit authority for consumer changes and each deployment/production gate;
- execution of the canaries and a passing identifier-free audit result.

Phase 5 migration waves remain blocked until the live Phase 4 evidence passes.
Private plans and evidence must be stored outside this public checkout. This
checkpoint authorizes no live mutation and contains no production or secret
material.
