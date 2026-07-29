# Flama Governance Controller

This is the external, read-only cross-company governance collector. It is not a
Paperclip agent and it does not modify Paperclip. The runtime uses the released
Paperclip package's documented HTTP API as-is and a hard GET-only transport.
Its GitHub transport is likewise GET-only.

The collector reads:

- company identity, controller metadata, and managed pipeline metadata from
  Paperclip;
- completed final-gate workflow runs and exact-attempt job timestamps from
  GitHub Actions; and
- the private repository/profile selectors supplied in the run input.

It reports controller and lifecycle compliance, workflow wall and queue-time
percentiles, retry observations, and summed runner time. GitHub's metadata APIs
do not expose cache hits per run, so cache-hit coverage remains explicitly
`not_emitted` until the generated workflows publish a bounded cache signal.

## Identity boundary

Provision six distinct read-only machine identities: one Paperclip identity and
one GitHub App installation identity for each scope. Inject them at runtime
through Infisical. The process rejects a credential reused across scopes.

Required environment names are:

```text
FLAMA_GOVERNANCE_MAXBEC_PAPERCLIP_API_URL
FLAMA_GOVERNANCE_MAXBEC_PAPERCLIP_API_KEY
FLAMA_GOVERNANCE_MAXBEC_GITHUB_TOKEN
FLAMA_GOVERNANCE_NAVIGAITE_PAPERCLIP_API_URL
FLAMA_GOVERNANCE_NAVIGAITE_PAPERCLIP_API_KEY
FLAMA_GOVERNANCE_NAVIGAITE_GITHUB_TOKEN
FLAMA_GOVERNANCE_EDILIO_PAPERCLIP_API_URL
FLAMA_GOVERNANCE_EDILIO_PAPERCLIP_API_KEY
FLAMA_GOVERNANCE_EDILIO_GITHUB_TOKEN
```

GitHub identities need only repository metadata and Actions read access for
their matching owner. The runtime accepts the installation-token form only, not
personal access tokens. Paperclip identities need company read access only. The
runtime has no POST, PUT, PATCH, or DELETE request primitive and no access to
secret-listing endpoints.

## Run contract

Build `bin/governance/index.js` with the signed platform artifact, then invoke:

```bash
node bin/governance/index.js \
  --input /protected/private/governance-input.json \
  --output /protected/private/governance-result.json
```

The input must validate against `schemas/governance-input.schema.json`, cover a
positive window of at most 31 days, contain all three exact company/owner
bindings, and stay outside the public checkout. The output is create-only mode
`0600`. Standard output contains only `status` and the result's SHA-256 digest;
errors contain one stable reason and never reflect input, paths, API bodies, or
credentials.

The reader follows Paperclip's packaged routine/API documentation and GitHub's
official [workflow-runs](https://docs.github.com/en/rest/actions/workflow-runs)
and [workflow-jobs](https://docs.github.com/en/rest/actions/workflow-jobs)
endpoints. Live collection and scheduling remain gated on provisioning the six
read-only identities and the private selector file.
