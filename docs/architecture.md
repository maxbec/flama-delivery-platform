# Architecture

This document records approved decisions from the Flama Software Delivery
Platform Plan. It does not add deployment authority or resolve implementation
choices that the plan leaves open.

## Authority

| Actor | Authority |
| --- | --- |
| Paperclip | Intent, task readiness, preflight, repair, orchestration, evidence |
| GitHub | Source, protected merges, final verification, releases, deploy execution |
| Max | Production authorization by approving the exact deployment PR SHA |
| Coding agent | Assigned source/spec changes in one isolated task worktree |
| Company Delivery Controller | Deterministic lifecycle orchestration for one company |
| Governance Controller | Read-only cross-company compliance and cost aggregation |

No automated actor has routine branch-protection bypass. Externally verifiable
states advance only from signed GitHub or Paperclip evidence.

## Branch profiles

Fast repositories use `feature/* → main`. Major repositories use
`feature/* → dev → main`; `dev` is the default integration branch and `main` is
stable. Classification defaults to Fast and selects Major only for a strong
integration, staging, migration, coupling, coordination, or production-risk
need. Profile changes are explicit migrations.

Every code PR SHA requires signed `Paperclip Preflight` evidence. GitHub owns
the authoritative final build/test gate at the `main` boundary. Production is a
separate deployment PR and never follows automatically from a code merge alone.

Generated callers run a standalone Branch Guard on every profile PR. Policy
Gate checks the repository contract, generated trust boundary, and exact
GitHub-App-authored preflight evidence without duplicating consumer tests.
Final Gate executes `./scripts/delivery full` on the pull request to `main`,
before merge. A manifest-only deployment PR takes strict manifest validation
instead of the application suite.

## Trust boundaries

The untrusted public lane has read-only permissions and no secrets, OIDC,
trusted cache writes, production network, homelab runner, or
`pull_request_target` execution. Trusted release and deployment lanes run only
for protected internal commits, request narrowly scoped short-lived identity,
and receive production values only after owner approval.

Paperclip is an external platform boundary. Flama uses the released PaperclipAI
package and its documented APIs, adapters, skills, and configuration as-is. The
delivery platform must not patch installed PaperclipAI code, vendor or fork its
source, add a source submodule, or depend on repository-local package patches.
Compatibility logic belongs in Flama-owned clients and contracts, and an
upstream incompatibility must fail closed or be resolved upstream.

Company-local Delivery Controllers are zero-budget Paperclip `process` agents
and remain paused until their deterministic runtime and scoped identity are
verified. Because Paperclip agents are company-scoped, the approved
`flama-governance-controller` is an external read-only service. It uses a
separate read-only identity for each company, aggregates metadata only, and has
no Paperclip, GitHub, release, deployment, approval, or secret-write authority.
The exact topology is enforced by `policies/paperclip-topology.json`.

The governance runtime additionally enforces that boundary in code: it has only
a GET request primitive, derives each allowed company/owner pair from a fixed
contract, rejects credentials reused across scopes, bounds pagination, response
size, latency, and collection windows, and suppresses all response bodies on
failure. Detailed results are create-only mode-0600 evidence outside the public
checkout; ordinary logs receive only a status and evidence digest. GitHub run
and exact-attempt job metadata provide duration, queue, retry, and runner-time
measurements. Cache-hit coverage is explicitly unavailable until generated
consumer workflows emit a bounded signal.

Nightly reconciliation has a separate read-only boundary. PostgreSQL sessions
default to read-only and use a bounded repeatable-read transaction; Paperclip
requests are hard-coded to GET. The audit compares aggregate queue, dead-letter,
binding, authorization, case, and transition-event state without emitting
repository, delivery, case, pipeline, or company identifiers. Detailed evidence
is create-only mode `0600`; normal output contains only status and digests.
Reconciliation cannot replay queues, mutate Paperclip, infer bindings, or scan
GitHub until the later scoped App identities and private selectors exist.

The company controller dispatches that audit only for one active assignment
whose execution run matches its current Paperclip run and whose issue, routine,
schedule trigger, and routine-run records match the repository-pinned contract.
Manual routine runs, arbitrary issues, concurrent assignments, disabled or
drifted routines, and unbound runs fail closed before the database is opened.
After evidence is safely persisted outside the checkout, the controller uses
Paperclip's documented issue-update API only to mark a compliant execution done
or route a non-compliant execution to review with a status and evidence digest.

## Artifact and deployment contract

Release packaging produces an immutable artifact with digest, SBOM, signature,
and provenance. Deployment adapters validate and deploy that exact artifact;
they never rebuild source. Verification performs immediate version, health, and
smoke checks followed by a ten-minute soak. Failure restores the previous
artifact once and opens an incident rather than repeatedly redeploying.

## Secrets

Infisical is authoritative. Delivery preference is GitHub OIDC retrieval,
workload identity, process injection, Infisical Secret Sync, then an approved
direct-destination exception. Public PR jobs cannot request an identity token or
reach Infisical. Machine-readable configuration contains identifiers and paths,
never values.

The secret audit consumes metadata only. It requires a non-shared, short-lived
machine identity with exact issuer, audience, repository, workflow, and
ref/environment claims plus project/environment/path scope. It rejects broad
Secret Sync targets, implicit key selection, stale rotations, unapproved direct
destination secrets, production credentials in build/release jobs, and any
secret-classified repository variable, generated field, or Paperclip prompt.
Findings contain stable codes and coarse locations, never secret names or values.

## Canary boundary

Representative canary selection and evidence are private operational inputs.
The deterministic canary gate requires coverage of both profiles and
visibilities, each approved owner, a legacy stack, a library release, Docker,
and a managed platform. It binds every candidate to an exact source SHA,
inventory digest, platform commit, and GitHub, Infisical, and Paperclip policy
digests. Forks, archived repositories, stale profile branches, duplicate
candidates, and incomplete coverage fail closed.

The audit requires exact-SHA proof of preflight, auto-merge, release,
deployment approval, secret isolation, Infisical OIDC and Secret Sync, rollback,
event replay, and pooled-cost targets where applicable. Its public result is
identifier-free: aggregate booleans and proof states, stable finding codes, and
content digests only. Planning and auditing do not select a live repository,
read a credential, mutate a consumer, approve production, or execute a canary.
Those actions remain separately gated by private mappings and scoped authority.

## Migration gates

1. Prove the inventory and exclusions.
2. Build and release the central platform.
3. Establish Paperclip controllers, lifecycles, bridge, and routines.
4. Configure scoped GitHub Apps, Infisical mappings, rulesets, and runners.
5. Prove representative canaries across owner, visibility, profile, stack,
   release, artifact, and deployment-provider boundaries.
6. Migrate batches of three to five consumers, stopping when one platform defect
   affects two repositories.
7. Audit all 64 consumers before retiring v3.

## Approved runtime

Max approved the runtime decision on 2026-07-28 and subsequently selected
Node.js 26 as the baseline:

- TypeScript 7 with strict compilation and Node.js 26.
- pnpm workspaces with an exact package-manager version and frozen lockfile.
- AJV using JSON Schema 2020-12 at all external JSON boundaries.
- Fastify for the bridge HTTP boundary.
- PostgreSQL 18 for the durable webhook inbox, Paperclip transition outbox,
  bounded retries, and dead-letter records.
- Vitest unit tests and Testcontainers integration tests against PostgreSQL 18.

The bridge remains undeployed until its Phase 2 deployment is separately
approved with scoped identities and private mappings. Provider credentials,
GitHub App installation, and production authority are not implied by this
runtime choice.

The governance collector is likewise deployment-ready but undeployed. Running
it requires six newly provisioned read-only identities and a private selector
file, neither of which is embedded in the public artifact.

The trusted deploy workflow verifies the GitHub OIDC token's issuer, audience,
repository, production subject, and `job_workflow_ref` for the exact platform
commit before provider code can request identity. It also re-queries the merged
deployment PR and requires `maxbec`'s latest approval to reference the exact PR
head SHA. The Infisical identity must enforce equivalent hardcoded claims.
