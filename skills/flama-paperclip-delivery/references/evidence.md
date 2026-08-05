# Evidence requirements

Use structured machine-readable evidence. Never include secret values, webhook signatures, authorization headers, raw environment dumps, or unrestricted webhook payloads.

## Preflight

Validate evidence against `schemas/preflight-evidence.schema.json`. Bind it to the repository, base SHA, exact head SHA, ephemeral runner, deterministic commands, declared release impact, and controller signature. Any new commit invalidates it.

## Pull request and merge

Use GitHub IDs, URLs, base/head SHAs, check conclusions, review state, and merge SHA from authenticated GitHub events or API reads. Do not treat an agent statement as evidence.

## Release

Record the immutable tag, release ID, source SHA, artifact digest, signature/attestation, SBOM digest, structured notes, and Release Case link. Release Please determines SemVer.

## Deployment

Validate the production manifest and deployment PR audit inputs. Approval must be Max's latest approval on the exact PR head SHA, and the PR may change only the approved deployment manifest. Record exact artifact digest, provider evidence, deployed version, safe HTTPS URL, health/smoke observations, soak result, and at most one rollback result.

## Reconciliation

Reconstruct Paperclip state from immutable GitHub evidence and bridge delivery IDs. Deduplicate events. Record mismatches as reason codes and create remediation work for unsafe or destructive drift.
