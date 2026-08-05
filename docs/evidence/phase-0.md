# Phase 0 evidence — authoritative inventory

Status: complete

Raw evidence, timestamps, identifiers, and Paperclip inventory measurements are
kept in protected local evidence storage and intentionally not published.

## GitHub scope

| Owner | Consumers | Private | Public | Excluded forks | Excluded archives |
| --- | ---: | ---: | ---: | ---: | ---: |
| `maxbec` | 15 | 11 | 4 | 13 | 0 |
| `navigaite` | 11 | 9 | 2 | 0 | 3 |
| `edilio-app` | 2 | 1 | 1 | 0 | 0 |
| **Total** | **28** | **21** | **7** | **13** | **3** |

The newly created `maxbec/flama-delivery-platform` is recorded separately with
the `platform` disposition. It is mutable as the platform source of truth but is
not consumer 29 and does not change the corrected 28-consumer completion target.

Safety proof:

- the live inventory was revalidated at `2026-07-30T08:31:24Z`; its protected
  snapshot digest is
  `sha256:c8d83a95c3798195ae3aaba41007aaf20fc86c0904f707ba0677f68f5d76eed1`;
- Owned records observed: 28 consumers, the inventory-only exclusions, and one
  central platform repository;
- zero fork or archived records allow mutation;
- all observed owner counts equal `policies/repository-scope.json`;
- 42 consumers require legacy default-branch normalization;
- initial automatic profiles are 57 Fast and 7 Major;
- zero consumers currently contain any new Flama delivery entrypoint;
- default-branch status rollup: 4 green, 2 red, 1 pending, 7 unknown, and 50
  with no runs.

Detected provider indicators include seven Docker repositories and two Vercel
repositories. These are indicators for canary selection, not authorization to
deploy or a substitute for provider validation.

## Paperclip status quo

Read-only live queries proved:

- the expected company scope is reachable;
- no pre-existing Flama delivery pipeline, controller, governance controller, or
  shared delivery skill configuration was detected.

Paperclip therefore does not yet satisfy project/workspace binding, lifecycle,
controller, skill, bridge, or signed-preflight requirements. Those are Phase 2
work and are not claimed complete here.

## Verification

The inventory implementation was developed test-first. Verification covered:

- fixture classification and exact-count mismatch rejection;
- fork/archive mutation denial;
- platform-versus-consumer distinction;
- profile, stack, provider, and Paperclip company classification;
- offline mocked live-serializer regression coverage;
- JSON Schema validation of the 96-record live snapshot;
- JSON syntax and policy invariant checks;
- clean Git whitespace checks.

No consumer, fork, archived repository, GitHub setting, Paperclip object,
Infisical object, runner, or production system was mutated during Phase 0.
