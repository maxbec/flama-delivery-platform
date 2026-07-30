# Deployment provider adapters

Plan section 14 names eight providers and requires each to implement `validate`,
`deploy`, `health`, `rollback`, `deployment_url`, `deployed_version`, and
`evidence`. Plan section 19 makes shared deployment logic centrally owned and
leaves only provider parameters to the consumer repository.

## Implementation status

| Provider | State |
| --- | --- |
| `docker-compose` | Implemented as a platform builtin, local Docker endpoint. |
| `digitalocean-droplet` | Implemented, remote Docker endpoint over SSH. |
| `hostinger-vps` | Implemented, remote Docker endpoint over SSH. |
| `vercel-prebuilt` | Implemented, prebuilt upload with REST read-back verification. |
| `digitalocean-app` | Implemented, digest-pinned app spec with phase verification. |
| `coolify` | Not implemented. Fails closed. |
| `render` | Not implemented. Fails closed. |
| `custom` | By definition repository-supplied; never a builtin. |

A Droplet and a Hostinger VPS are both a server running Docker, so they are the
compose mechanism bound to a remote endpoint rather than two separate
integrations. Each adapter still reports its own provider name, so the manifest,
the loader check, and the recorded evidence stay exact.

The remaining four are API- or CLI-driven and are deliberately not written from
assumed request shapes: a wrong contract in a production deployment path is worse
than an explicit refusal.

### Verified contracts

- **Render**: `POST /v1/services/{serviceId}/deploys` with `imageUrl` for
  image-backed services, and `GET /v1/services/{serviceId}/deploys/{deployId}`.
  Note that `deployMode` cannot be combined with `imageUrl`. The deploy `status`
  enumeration is not published in the reference and is still unconfirmed.
- **Vercel** (CLI, fully documented): `vercel deploy --prebuilt --prod
  --non-interactive`, optionally `--archive=tgz`; stdout is always the deployment
  URL and a non-zero exit code means failure. `vercel rollback [deployment-id or
  url]` performs an instant rollback, `vercel promote` undoes one, and
  `VERCEL_TOKEN` is the documented CI channel — Vercel recommends it over `--token`
  precisely because an argument "can be visible in process lists and logs", which
  is also what plan section 15.8 requires.
- **Coolify**: `POST /deploy?uuid=<resource>` returns
  `{ deployments: [{ deployment_uuid, resource_uuid, message }] }`, and
  `GET /deployments/{uuid}` returns an `ApplicationDeploymentQueue`. Its published
  OpenAPI declares `status` as an untyped `string` with **no enum**. The
  implementation enum (`app/Enums/ApplicationDeploymentStatus.php`) is
  `queued`, `in_progress`, `finished`, `failed`, `cancelled-by-user`, so `finished`
  is the successful terminal value — but that is an internal detail the API contract
  does not guarantee.

### Why Coolify and Render are still not implemented

Neither publishes the one thing a `health()` implementation cannot do without: a
declared set of terminal deployment states.

- **Render**: the deploy `status` enumeration does not appear in the published
  reference, and the OpenAPI link on the documentation site serves HTML rather than a
  specification.
- **Coolify**: the specification types `status` as a bare `string`. Depending on the
  implementation enum instead is defensible only because Coolify is self-hosted at a
  version the operator pins, and it would still need a fail-closed default so an
  unrecognized status reads as unhealthy.

Without declared terminal states, `health()` cannot distinguish "still deploying"
from "failed" — which is exactly the trap that makes `ACTIVE`-only correct for
DigitalOcean and `READY` + production target correct for Vercel. A `health()` that
cannot detect failure would let the orchestrator pass a broken deployment through
its soak window, so both providers keep refusing.

A second question applies to Coolify specifically: plan section 14 forbids
rebuilding source during deployment, so the resource would have to be configured as
an image-based application with the digest pinned on the resource before
`POST /deploy` is called. That resource-configuration path is not yet verified.

## digitalocean-app behaviour

App Platform deploys whatever image the app spec records, so a deployment is a
spec update that pins the exact digest followed by one created deployment. The
contract was taken from DigitalOcean's published OpenAPI specification, not from
assumption.

- `digest` is mutually exclusive with `tag` in the image source spec, and `tag`
  defaults to `latest` when neither is given — exactly what plan section 14 forbids.
  The adapter therefore always writes `digest` and removes `tag`.
- **`update_all_source_versions` must be `true`.** It defaults to `false`, and in
  that state DigitalOcean updates only newly added sources. A spec update carrying a
  changed digest would then be silently ignored: the request would succeed while the
  app kept serving the previous image. The client always sends it, and a test
  asserts the exact request body.
- `force_build: false` on deployment creation, because a provider must not rebuild
  source during deployment.
- `health()` is true only for the `ACTIVE` phase. Every other published phase —
  `UNKNOWN`, `PENDING_BUILD`, `BUILDING`, `PENDING_DEPLOY`, `DEPLOYING`,
  `SUPERSEDED`, `ERROR`, `CANCELED` — reports unhealthy, so an in-progress or
  superseded deployment can never verify.
- `deployed_version()` reads the live digest back out of the app spec. This is a
  genuinely independent read, stronger than the Vercel provider's: if anything
  re-points the app after deployment, the read-back digest no longer matches and the
  adapter reports that digest, which surfaces to the orchestrator as a version
  mismatch rather than a false success.
- Verification is refused before any deployment has been performed.

## vercel-prebuilt behaviour

`vercel inspect` has no machine-readable output, so verification uses the REST
deployment record instead: `GET /v13/deployments/{idOrUrl}` returns `readyState`,
`target`, and the `meta` values recorded at deploy time.

That distinction is the point. Satisfying `deployed_version` from the CLI alone
would mean returning the version the adapter just deployed, which makes the
orchestrator's `deployedVersion === expectedVersion` check tautological and lets a
failed deployment verify successfully. Plan section 4 forbids advancing an
externally verifiable state by claiming success, so the version is read back from
Vercel's own record.

- `validate` requires a full `sha256:` digest and a repository-relative prebuilt
  output path, never a registry reference. When a previous artifact is present its
  URI must be a previous `https` deployment URL, because an instant rollback
  targets a deployment rather than an artifact path.
- `deploy` runs `vercel deploy --prebuilt --prod --non-interactive --archive=tgz`
  with `--meta flamaVersion=<version>`. `--prebuilt` uploads the output of an
  earlier trusted `vercel build`, so no source is rebuilt on the deployment runner.
  Vercel documents that deploy stdout is always the deployment URL; anything else
  fails closed rather than hiding a failed deploy.
- `health` requires `readyState === "READY"` **and** `target === "production"`, read
  back from the deployment record.
- `rollback` runs `vercel rollback <previous deployment URL>` for an instant
  rollback, then verifies that deployment.
- `deployed_version` returns the `flamaVersion` meta value Vercel recorded, and
  fails closed when it is absent.
- Verification is refused entirely before a deploy or rollback has been performed,
  so no adapter instance can report on a deployment it did not make.

**Known limitation:** the meta value is written by the platform, so reading it back
proves the production-targeted deployment that reached READY is the one the platform
created with that version. It does not independently fingerprint the served bundle
the way the Docker provider's image digest does.

### Credential handling

The token is injected, never read from the manifest, and travels only in the child
environment as `VERCEL_TOKEN`. Vercel recommends exactly this over `--token`
because an argument "can be visible in process lists and logs", which is also what
plan section 15.8 requires. The registry refuses to build the adapter at all when no
credential is supplied rather than attempting an unauthenticated deployment, and
REST error bodies are never surfaced.

An unimplemented provider is refused rather than substituted, so a consumer can
never silently deploy through a different mechanism than its manifest declares.

## Selection

`flama-delivery-ctl deploy` and `flama-delivery-ctl rollback` resolve the adapter
as follows:

- `--adapter <repository-relative path>` loads a repository-supplied adapter.
  This is how the `custom` provider works, and it keeps the existing loader's
  symlink and path-escape checks.
- Without `--adapter`, the platform builtin for `provider.name` is constructed
  from `provider.parameters` in the deployment manifest. Consumers therefore do
  not copy shared deployment logic.

## Repository-owned parameters

`provider.parameters` in `.deploy/production.yaml` carries non-secret values
only. The schema enforces string values, bounded key names and lengths, and
rejects obvious credential material. Secrets stay Infisical-authoritative under
`provider.infisicalPath`.

`docker-compose` requires:

```yaml
provider:
  name: docker-compose
  parameters:
    composeFile: deploy/compose.yaml
    projectName: flama-api
    service: api
    deploymentUrl: https://api.example.test
```

A remote provider additionally requires `dockerHost`, which must be an `ssh://`
endpoint: Docker's TCP endpoint is unauthenticated and unencrypted by default, a
local socket is not a remote deployment, and an embedded password is refused
because that credential belongs in Infisical and the SSH agent. A local
`docker-compose` deployment must not carry `dockerHost` at all.

`composeFile` must be repository-relative and may not escape the checkout,
`projectName` and `service` are restricted to safe identifier shapes, and
`deploymentUrl` must be `https` with no embedded credentials.

## docker-compose behaviour

- `validate` accepts only artifacts pinned to their exact recorded digest. A
  tag reference, a `:latest` reference, or a reference whose digest contradicts
  the manifest is rejected without contacting Docker.
- `deploy` and `rollback` pull the digest and run
  `compose up --detach --no-build`, passing the pinned reference as
  `FLAMA_IMAGE`. `--no-build` means a compose file containing a `build:` stanza
  still cannot compile source on the deployment runner, which is what plan
  section 14's "providers must not rebuild source during deployment" requires.
- `health` requires the service to be `running` **and** its healthcheck to report
  `healthy`. A running container with no healthcheck is reported unhealthy, so a
  deployment is never verified by process liveness alone.
- `deployed_version` reads the running image's `org.opencontainers.image.version`
  label and fails closed when the label is absent.
- `evidence` reports the container identity and the observation time.

## Command execution safety

`SystemCommandRunner` spawns without a shell, refuses anything but a bare
executable name, and rejects environment values containing newlines. The child
receives an explicit minimal environment (`PATH`, `HOME`, and Docker endpoint
selection) plus the values the adapter supplies, so an unrelated parent variable
cannot become part of a deployment. Deployment values travel through the
environment rather than the argument list, keeping them out of process listings,
and captured output is bounded.
