import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  auditReleaseEvidence,
  GitHubCliReleaseVerifier,
  planReleaseEvidence,
  ReleaseEvidenceError,
  type ObservedRelease,
  type ReleaseEvidenceInput,
  type ReleaseVerifier,
} from "./release-evidence.js";

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

class FakeVerifier implements ReleaseVerifier {
  readonly verifiedAssets: string[] = [];
  releaseVerified = false;

  constructor(readonly observed: ObservedRelease) {}

  async inspectRelease(): Promise<ObservedRelease> {
    return this.observed;
  }

  async verifyRelease(): Promise<void> {
    this.releaseVerified = true;
  }

  async verifyAsset(_repository: string, _tagName: string, path: string): Promise<void> {
    this.verifiedAssets.push(path);
  }
}

async function fixture(): Promise<{
  root: string;
  input: ReleaseEvidenceInput;
  observed: ObservedRelease;
}> {
  const root = await mkdtemp(join(tmpdir(), "flama-release-evidence-"));
  const artifactName = "example-v1.2.3.tar.gz";
  const sbomName = "example-v1.2.3.sbom.spdx.json";
  const checksumName = `${artifactName}.sha256`;
  const artifact = "deterministic artifact\n";
  const sbom = '{"spdxVersion":"SPDX-2.3"}\n';
  const artifactDigest = digest(artifact);
  const checksum = `${artifactDigest.slice("sha256:".length)}  ${artifactName}\n`;
  await Promise.all([
    writeFile(join(root, artifactName), artifact),
    writeFile(join(root, sbomName), sbom),
    writeFile(join(root, checksumName), checksum),
  ]);
  const input: ReleaseEvidenceInput = {
    schemaVersion: 1,
    repository: {
      nameWithOwner: "maxbec/example",
      disposition: "in_scope",
      isFork: false,
      isArchived: false,
    },
    release: { version: "1.2.3", tagName: "v1.2.3", headSha: "a".repeat(40) },
    files: {
      artifact: { path: artifactName, name: artifactName, digest: artifactDigest },
      sbom: { path: sbomName, name: sbomName, digest: digest(sbom) },
      checksum: { path: checksumName, name: checksumName, digest: digest(checksum) },
    },
  };
  return {
    root,
    input,
    observed: {
      releaseId: 123,
      tagName: "v1.2.3",
      headSha: "a".repeat(40),
      isDraft: false,
      isPrerelease: false,
      isImmutable: true,
      repositoryImmutable: true,
      assets: Object.values(input.files).map(({ name, digest: fileDigest }) => ({
        name,
        digest: fileDigest,
      })),
    },
  };
}

describe("release evidence", () => {
  it("plans the immutable verification without accessing files or GitHub", async () => {
    const { input } = await fixture();
    expect(planReleaseEvidence(input)).toMatchObject({
      status: "planned",
      version: "1.2.3",
      tagName: "v1.2.3",
      requiredFiles: 3,
      verification: { releaseAttestation: true, assetAttestations: 3 },
    });
  });

  it("binds local digests, immutable release state, source SHA, and signed assets", async () => {
    const { root, input, observed } = await fixture();
    const verifier = new FakeVerifier(observed);
    const result = await auditReleaseEvidence(input, root, verifier);

    expect(result).toMatchObject({
      status: "verified",
      releaseId: 123,
      headSha: "a".repeat(40),
      artifactDigest: input.files.artifact.digest,
      verification: {
        repositoryImmutable: true,
        releaseImmutable: true,
        releaseAttestation: true,
        assetAttestations: 3,
      },
    });
    expect(verifier.releaseVerified).toBe(true);
    expect(verifier.verifiedAssets).toHaveLength(3);
  });

  it("fails closed before attestation checks when checksum content is inconsistent", async () => {
    const { root, input, observed } = await fixture();
    const checksumPath = join(root, input.files.checksum.path);
    const invalidChecksum = `${"f".repeat(64)}  ${input.files.artifact.name}\n`;
    await writeFile(checksumPath, invalidChecksum);
    const changedInput: ReleaseEvidenceInput = {
      ...input,
      files: {
        ...input.files,
        checksum: { ...input.files.checksum, digest: digest(invalidChecksum) },
      },
    };

    await expect(auditReleaseEvidence(changedInput, root, new FakeVerifier(observed))).rejects.toMatchObject({
      code: "release_checksum_invalid",
    });
  });

  it("denies forked repositories and exact-source mismatches", async () => {
    const { root, input, observed } = await fixture();
    const forkedInput = {
      ...input,
      repository: { ...input.repository, isFork: true },
    } as unknown as ReleaseEvidenceInput;
    expect(() => planReleaseEvidence(forkedInput)).toThrow(ReleaseEvidenceError);
    await expect(auditReleaseEvidence(input, root, new FakeVerifier({
      ...observed,
      headSha: "b".repeat(40),
    }))).rejects.toMatchObject({ code: "release_source_mismatch" });
  });

  it("rejects non-installation credentials without reflecting their value", () => {
    const value = "credential-value-that-must-not-appear";
    try {
      new GitHubCliReleaseVerifier({ FLAMA_GITHUB_APP_INSTALLATION_TOKEN: value });
      throw new Error("expected verifier construction to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ReleaseEvidenceError);
      expect(String(error)).not.toContain(value);
    }
  });
});
