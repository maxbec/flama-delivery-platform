# Paperclip routine provisioning

This runbook provisions the managed routines without modifying, patching, or
vendoring Paperclip. It uses the released Paperclip API and leaves every new
routine paused. A successful command does not authorize activation, bridge
deployment, production access, or a consumer migration.

## Preconditions

Do not create a live GitHub-transition trigger until all of these are true:

1. The company controller has passed Paperclip's native board approval, is
   paused and zero-budget, and runs the immutable platform-release entrypoint.
2. A human has selected the authoritative Paperclip project and workspace; the
   platform must not infer either from names.
3. The exact Infisical project, environment, and canonical path are approved.
4. An OIDC-authenticated, short-lived Infisical token is available to the
   provisioning process with write access only to that path.
5. The machine-readable `provider_native_secret` exception for
   `PAPERCLIP_ROUTINE_WEBHOOK_SECRET` is approved, current, and not review-due.
   It covers only the verifier copy that released Paperclip necessarily retains.
6. A temporary Paperclip operator credential is available for configuration.
   This is not a bridge credential, reader account, Viewer account, or runtime
   dependency; revoke it after the provisioning readback.

## Prepare the private input

Create the input outside the public checkout in a mode-`0600` directory. Use
the schema
`paperclip-github-transition-routine-input.schema.json` as the exact field
reference. The file contains identifiers, paths, and exception metadata, but no
secret value.

Never add the input, command output, evidence, environment dump, or shell
history containing credentials to Git. Do not place a token or generated
secret in a command argument.

## Validate and dry-run

From the immutable platform release root:

```bash
node bin/flama-delivery-ctl.js validate \
  --schema paperclip-github-transition-routine-input \
  --input /protected/private/github-transition-routine.json

node bin/flama-delivery-ctl.js paperclip-github-transition-routine \
  --dry-run \
  --input /protected/private/github-transition-routine.json
```

Dry-run requests no Paperclip or Infisical identity. Its result must say
`planned`, `paused`, `hmac_sha256`, and `infisicalSynced: false`; it must not
contain IDs, paths, URLs, or values.

## Apply while remaining paused

Inject the temporary Paperclip operator token and the short-lived Infisical
OIDC token into the process environment using the approved secret delivery
mechanism. The command reads `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY`,
`INFISICAL_API_URL`, and `INFISICAL_TOKEN`; do not print them or pass them as
arguments.

```bash
node bin/flama-delivery-ctl.js paperclip-github-transition-routine \
  --input /protected/private/github-transition-routine.json \
  --output /protected/evidence/github-transition-routine-result.json
```

The installer verifies the exact company, controller, project, contract,
Infisical mapping, and exception. It then creates or reuses the paused routine.
When trigger creation or rotation returns one-time material, the URL and secret
remain in memory while the exact bridge keys are upserted to Infisical.
Infisical write-response bodies are deliberately discarded because they echo
values.

The success result contains only routine and trigger dispositions, boolean
Infisical synchronization state, and contract/exception digests. It never
contains the Paperclip object IDs, public trigger ID, webhook URL, secret,
Infisical path, or rotation timestamp.

## Readback and recovery

Rerun the same command with the same exact private input. It requests Infisical
metadata with `viewSecretValue=false` and `expandSecretReferences=false`.

- An exact trigger-bound receipt produces `triggerDisposition: reused` and no
  rotation until the approved rotation interval is due.
- A routine with no trigger resumes trigger creation.
- A missing or partial two-secret receipt rotates the Paperclip secret once and
  replaces both Infisical entries.
- A receipt at or beyond its approved rotation interval is rotated and both
  Infisical entries are replaced even when its metadata is otherwise exact.
- Routine activation, duplicate routines, contract drift, controller drift,
  missing approval, an expired/review-due exception, or an unavailable provider
  fails closed with a stable code and no response body.

After a successful readback, revoke the temporary Paperclip operator token and
allow the short-lived Infisical token to expire or revoke it according to the
identity policy. Keep private inputs and evidence only for the approved
retention period.

## Activation boundary

Do not activate the routine from this runbook. Activation requires the deployed
bridge, private repository/case bindings, exact controller authorizations,
canary evidence including replay, and explicit production authority. The
released Paperclip package remains unchanged throughout.
