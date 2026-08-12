# Platform release operations

Build the immutable release inputs from a clean, signed commit:

```bash
pnpm install --frozen-lockfile
./scripts/delivery full
pnpm release:build
```

The `release/` directory receives:

- `flama-delivery-platform-v<version>.tar.gz`
- `flama-delivery-platform-v<version>.tar.gz.sha256`
- `flama-delivery-platform-v<version>.sbom.spdx.json`

The reusable release-evidence workflow does not repeat `full`. Its read-only
package job invokes only `./scripts/delivery buildable`, validates the archive,
checksum, and SBOM paths, verifies the checksum, normalizes exactly three files,
and transfers them without compression. A separate least-privilege job
recomputes every digest and creates the provenance attestations. That identity-
capable job does not check out or execute repository code.

The archive contains the self-contained Node.js 26 CLI, bridge, native company
controller, and read-only governance executables, third-party license notices, schemas, policies,
templates, reusable workflows, bridge migrations, SPDX SBOM, and a release
manifest with per-file digests. Its file order, ownership, timestamps, gzip
header, SBOM timestamp, and manifest timestamp derive from the signed Git
commit, so independent builds are byte-identical.

Publishing is performed by `.github/workflows/release.yml` after a Release
Please pull request is merged. Release Please owns only the version/changelog
pull request; `skip-github-release` deliberately leaves tag and release creation
to the trusted publisher. The publisher:

1. Lets Release Please determine the version from the release-impact/conventional
   commit history.
2. Authenticates as the existing owner-matched `flama-delivery-maxbec` GitHub
   App through Infisical OIDC, not a long-lived repository PAT or a fourth App.
3. Builds the archive twice and verifies byte-for-byte reproducibility from the
   exact protected SHA in an unprivileged job.
4. Creates a draft release, attaches the archive/checksum/SBOM, attests all
   three assets, and only then publishes it.
5. Requires repository release immutability so the published tag and assets
   lock.

The `platform-release` GitHub environment and Infisical OIDC identity must be
bound to `repo:maxbec/flama-delivery-platform:environment:platform-release`.
Configure these non-secret repository variables:

- `INFISICAL_IDENTITY_ID`
- `INFISICAL_DOMAIN`
- `INFISICAL_PROJECT_SLUG`
- `INFISICAL_ENV_SLUG`
- `INFISICAL_SECRET_PATH`

Set `INFISICAL_SECRET_PATH` to the existing `/github-apps/maxbec` mapping. It
contains `FLAMA_GITHUB_APP_ID_MAXBEC` and
`FLAMA_GITHUB_APP_PRIVATE_KEY_MAXBEC`; do not duplicate those values under
release-specific aliases. The workflow mints a token narrowed to
`maxbec/flama-delivery-platform` with Contents write and Administration read.
The latter is used only to fail closed unless release immutability is enabled.

Do not publish first and attach assets afterward: GitHub's immutable-release
model locks the tag and assets when the draft is published.

After publication, verify the exact local archive, checksum, and SBOM against
the immutable GitHub release and its cryptographically signed release/asset
attestations:

```bash
infisical run --env=ci -- \
  flama-delivery-ctl release-evidence \
  --input .flama/release-evidence.json \
  --output .flama/evidence/release.json
```

The Infisical injection supplies only a short-lived, single-repository GitHub
App installation token in `FLAMA_GITHUB_APP_INSTALLATION_TOKEN`. The command
does not accept credentials through arguments or files, suppresses verifier and
API response bodies, rejects forks/archives/out-of-scope owners, resolves the
tag to the expected source SHA, and writes a create-only mode-0600 result that
omits repository names and local paths.

The verifier requires all of the following to agree before it succeeds:

- repository immutable releases are enabled and the release is published and
  immutable;
- the release tag resolves to the expected protected source commit;
- GitHub asset digests match locally recomputed SHA-256 digests;
- the checksum content names and hashes the exact archive; and
- `gh release verify` and `gh release verify-asset` validate the signed release
  and all three assets.
