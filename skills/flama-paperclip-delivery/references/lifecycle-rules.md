# Lifecycle rules

## Routing

| GitHub owner | Paperclip company | Delivery Controller |
| --- | --- | --- |
| `maxbec` | `Private` | `maxbec-delivery-controller` |
| `navigaite` | `// Navigaite` | `navigaite-delivery-controller` |
| `edilio` | `Edilio` | `edilio-delivery-controller` |

Reject unknown owners. The global `flama-governance-controller` may aggregate read-only metadata but may not mutate company, GitHub, secret, release, or deployment state.

## Transition rules

Treat lifecycle JSON in the platform release as authoritative. A transition may occur only when:

1. the current state matches `from`;
2. the named actor has authority;
3. every listed evidence item exists and is bound to the current repository and SHA where applicable; and
4. the trigger was observed from its authoritative system.

Agents may report work results but may not synthesize GitHub or controller events. Signed external events exclusively advance PR, merge, release, approval, deployment, and verification stages.

## Definitions

Definition of Ready requires objective, scope, acceptance criteria, affected components, release impact, tests, build command, migration/deployment impact, security risk, dependencies, and rollback/compatibility considerations.

Definition of Done requires repository and merged SHA, PR URL, signed preflight, build and test evidence, GitHub checks, resolved threads, release impact, Release Case link, clean worktree, and acceptance-criteria evidence.

Normal implementation tasks close after merge. Release Cases track releases and production. Tasks requiring live behavior remain open until deployment is externally verified.

## Escalate only for

- production deployment PR approval;
- secret exposure;
- production rollback or unresolved outage;
- blocked destructive migration;
- critical pooled CI budget condition; or
- platform integrity or credential incident.
