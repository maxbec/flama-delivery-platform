#!/usr/bin/env bash
# Puts the platform CLI at <output-dir>/flama-delivery-ctl.js for the exact
# platform commit a consumer is pinned to.
#
# The released bundle is preferred: every consumer pin is a release tag (the
# policy gate refuses anything else), the bundle is a single file with no
# install, and it is byte-for-byte what the sweep on ai-vm runs. The tag is
# read from the platform repository, never from the consumer, exactly as the
# policy gate does it, and the download is verified against the checksum the
# release publisher wrote beside it.
#
# A commit no release tag points at — a platform change under test — is
# built from the checkout instead. That path installs and compiles, and is
# what the policy gate would reject on a real consumer; it exists so the
# workflow can be exercised before a release is cut.
#
# usage: obtain-cli.sh <platform-sha> <output-dir> <platform-checkout>
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo 'usage: obtain-cli.sh <platform-sha> <output-dir> <platform-checkout>' >&2
  exit 2
fi
sha=$1
output=$2
checkout=$3

[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo 'platform sha must be 40 hex characters' >&2; exit 2; }
[[ -d "$checkout" ]] || { echo 'platform checkout directory missing' >&2; exit 2; }

: "${FLAMA_PLATFORM_REPOSITORY:=maxbec/flama-delivery-platform}"
# Test seams: a tag the caller has already resolved, and where releases are
# fetched from. Production leaves both unset.
: "${FLAMA_PLATFORM_TAG_VERSION:=}"
: "${FLAMA_RELEASE_BASE_URL:=https://github.com/${FLAMA_PLATFORM_REPOSITORY}/releases/download}"

mkdir -p "$output"

# A tag source that cannot be read is a failure, never "no release": falling
# through to a source build because the network blinked would swap the
# provenance of what runs, silently.
resolve_tag_version() {
  local refs
  refs=$(git ls-remote --tags "https://github.com/${FLAMA_PLATFORM_REPOSITORY}.git") \
    || { echo "could not read platform release tags from ${FLAMA_PLATFORM_REPOSITORY}" >&2; return 1; }
  printf '%s\n' "$refs" | awk -v sha="$sha" '
    {
      ref = $2
      if (ref ~ /\^\{\}$/) { sub(/\^\{\}$/, "", ref); peeled[ref] = $1 }
      else { plain[ref] = $1 }
    }
    END {
      for (ref in plain) {
        commit = (ref in peeled) ? peeled[ref] : plain[ref]
        if (commit == sha && ref ~ /^refs\/tags\/v[0-9]+\.[0-9]+\.[0-9]+$/) {
          sub(/^refs\/tags\/v/, "", ref)
          print ref
        }
      }
    }' | sort -u
}

version=$FLAMA_PLATFORM_TAG_VERSION
if [[ -z "$version" ]]; then
  version=$(resolve_tag_version) || exit 1
fi
# Two release tags on one commit leave no single answer; refuse rather than guess.
[[ "$version" != *$'\n'* ]] || { echo 'more than one release tag points at the platform commit' >&2; exit 1; }

if [[ -n "$version" ]]; then
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'resolved release version is not semver' >&2; exit 1; }
  name="flama-delivery-platform-v${version}"
  work=$(mktemp -d "${TMPDIR:-/tmp}/flama-cli-release-XXXXXX")
  trap 'rm -rf "$work"' EXIT
  curl --fail --silent --show-error --location --retry 3 \
    --output "$work/$name.tar.gz" "${FLAMA_RELEASE_BASE_URL}/v${version}/${name}.tar.gz"
  curl --fail --silent --show-error --location --retry 3 \
    --output "$work/$name.tar.gz.sha256" "${FLAMA_RELEASE_BASE_URL}/v${version}/${name}.tar.gz.sha256"
  (cd "$work" && sha256sum --check --status "$name.tar.gz.sha256")
  # The checksum sits beside the tarball in the same release, so it proves
  # integrity, not origin. The provenance attestation the release workflow
  # signs proves the tarball was built by that workflow from this repository.
  # A gh too old to verify attestations says so and continues on the checksum
  # and manifest binding, which is what every consumer ran on before this
  # check existed; the seam that skips it outright is for the offline test.
  : "${FLAMA_RELEASE_ATTESTATION:=verify}"
  if [[ "$FLAMA_RELEASE_ATTESTATION" == "verify" ]]; then
    if gh attestation verify --help >/dev/null 2>&1; then
      gh attestation verify "$work/$name.tar.gz" --repo "$FLAMA_PLATFORM_REPOSITORY" >/dev/null
    else
      echo "::warning::gh on this runner cannot verify release attestations; relying on checksum and release manifest"
    fi
  fi
  # The whole release, not the bundle alone: the CLI locates its schemas and
  # policies by walking up from its own path, exactly as it does on ai-vm.
  rm -rf "$output/release"
  mkdir -p "$output/release"
  tar -xzf "$work/$name.tar.gz" -C "$output/release"
  # The release records the commit it was cut from; a tag moved onto another
  # commit would otherwise hand the consumer a different platform than it pinned.
  manifest_sha=$(node -p "require('$output/release/$name/release-manifest.json').commitSha")
  [[ "$manifest_sha" == "$sha" ]] || { echo 'release manifest names a different platform commit' >&2; exit 1; }
  entry="$output/release/$name/bin/flama-delivery-ctl.js"
  [[ -f "$entry" ]] || { echo 'release carries no CLI bundle' >&2; exit 1; }
  printf '#!/usr/bin/env node\nawait import(%s);\n' "$(node -p 'JSON.stringify(process.argv[1])' "$entry")" \
    > "$output/flama-delivery-ctl.js"
  chmod 0755 "$output/flama-delivery-ctl.js"
  printf 'flama-delivery-ctl from release v%s\n' "$version"
  exit 0
fi

echo "no release tag points at $sha; building the CLI from the checkout" >&2
(cd "$checkout" && pnpm install --frozen-lockfile >/dev/null && pnpm build >/dev/null)
entry=$(cd "$checkout" && pwd)/dist/packages/delivery-ctl/src/main.js
[[ -f "$entry" ]] || { echo 'platform build produced no CLI entrypoint' >&2; exit 1; }
printf '#!/usr/bin/env node\nawait import(%s);\n' "$(node -p 'JSON.stringify(process.argv[1])' "$entry")" \
  > "$output/flama-delivery-ctl.js"
chmod 0755 "$output/flama-delivery-ctl.js"
printf 'flama-delivery-ctl built from %s\n' "$sha"
