# Generated consumer templates

`common` supplies create-once repository-owned scaffolds for
`./scripts/delivery` and its Node-based argv dispatcher, plus the centrally
generated production deploy caller. Fast and Major directories supply their
profile-specific branch-guard, policy, and final workflow callers. Final Gate
runs on the pull request to `main`, before merge. Policy Gate validates the
contract and signed preflight check without duplicating consumer tests.

The renderer must replace every `__...__` token, validate the result, and pin
`__FLAMA_PLATFORM_REF__` to a full 40-character platform release commit. It
must render command values as non-empty JSON string arrays. The dispatcher uses
`spawn` with `shell: false`; it does not accept arbitrary command names or extra
arguments.

`bootstrap` may create a missing repository-owned scaffold but never overwrites
one. `render` manages only central workflow/policy metadata and fails on drift.
These files remain source templates only; their presence does not authorize
consumer changes before the canary migration phase.
