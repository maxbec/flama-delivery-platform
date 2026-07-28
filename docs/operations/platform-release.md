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

The archive contains the self-contained Node.js 26 CLI, third-party license
notices, schemas, policies, templates, reusable workflows, bridge migration,
SPDX SBOM, and a release manifest with per-file digests. Its file order,
ownership, timestamps, gzip header, SBOM timestamp, and manifest timestamp derive
from the signed Git commit, so independent builds are byte-identical.

Publishing is intentionally not enabled yet. The final trusted workflow must:

1. Let Release Please determine the version from the release-impact/conventional
   commit history.
2. Authenticate as the scoped release GitHub App through Infisical OIDC, not a
   long-lived repository PAT.
3. Build and verify the deterministic archive from the exact protected SHA.
4. Create a draft release, attach the archive/checksum/SBOM, attest the artifact
   and SBOM, and only then publish it.
5. Require repository release immutability so the published tag and assets lock.

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
