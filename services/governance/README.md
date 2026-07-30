# Flama Governance Controller

This is the deterministic, read-only cross-company governance job orchestrated
by Paperclip. Paperclip is the control plane: the job never authenticates back
into Paperclip as a human or board user and never modifies Paperclip. Native
company-local controller runs attest their own Paperclip state; this job
combines those attestations with GET-only GitHub metadata.

The collector reads:

- fresh digest-bound Paperclip state attestations produced by each native
  company controller;
- completed final-gate workflow runs and exact-attempt job timestamps from
  GitHub Actions; and
- the private repository/profile selectors supplied in the run input.

It reports controller and lifecycle compliance, workflow wall and queue-time
percentiles, retry observations, and summed runner time. GitHub's metadata APIs
do not expose cache hits per run, so cache-hit coverage remains explicitly
`not_emitted` until the generated workflows publish a bounded cache signal.

## Identity boundary

Paperclip supplies the orchestration and native company-controller run context;
no Paperclip Viewer account, board token, or cross-company API credential is
created. Provision one read-only GitHub App installation identity for each
owner and inject it at runtime through Infisical. The process rejects a GitHub
credential reused across owner scopes.

Required environment names are:

```text
FLAMA_GOVERNANCE_MAXBEC_GITHUB_TOKEN
FLAMA_GOVERNANCE_NAVIGAITE_GITHUB_TOKEN
FLAMA_GOVERNANCE_EDILIO_GITHUB_TOKEN
FLAMA_RECONCILIATION_EVIDENCE_DIR
```

GitHub identities need only repository metadata and Actions read access for
their matching owner. The runtime accepts the installation-token form only, not
personal access tokens. Its network layer has no POST, PUT, PATCH, or DELETE
request primitive and no Paperclip endpoint at all.

`FLAMA_RECONCILIATION_EVIDENCE_DIR` is the same protected absolute directory
used by the native company controllers. For every attestation embedded in a
governance input, the job requires an exact matching create-only mode-0600
`paperclip-governance-<run-id>.json` file in that directory. Missing, permissive,
symlinked, substituted, or mismatched evidence fails closed before any GitHub
request.

## Run contract

Build `bin/governance/index.js` with the signed platform artifact, then invoke:

```bash
node bin/governance/index.js \
  --input /protected/private/governance-input.json \
  --output /protected/private/governance-result.json
```

The input must validate against `schemas/governance-input.schema.json`, cover a
positive window of at most 31 days, contain all three exact company/owner
bindings and a fresh native controller attestation for each, and stay outside
the public checkout. The output is create-only mode `0600`. Standard output
contains only `status` and the result's SHA-256 digest; errors contain one
stable reason and never reflect input, paths, API bodies, or credentials.

The reader follows GitHub's official
[workflow-runs](https://docs.github.com/en/rest/actions/workflow-runs)
and [workflow-jobs](https://docs.github.com/en/rest/actions/workflow-jobs)
endpoints. Live collection and scheduling remain gated on native controller
attestation production, the three read-only GitHub App identities, and the
private selector file.
