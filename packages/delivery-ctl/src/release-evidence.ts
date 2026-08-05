import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

const githubApiVersion = "2026-03-10" as const;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const repositoryPattern = /^(?:maxbec|navigaite|edilio-app)\/[A-Za-z0-9._-]+$/u;
const tagPattern = /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;

export interface ReleaseEvidenceInput {
  readonly schemaVersion: 1;
  readonly repository: {
    readonly nameWithOwner: string;
    readonly disposition: "in_scope";
    readonly isFork: false;
    readonly isArchived: false;
  };
  readonly release: {
    readonly version: string;
    readonly tagName: string;
    readonly headSha: string;
  };
  readonly files: {
    readonly artifact: ReleaseEvidenceFile;
    readonly sbom: ReleaseEvidenceFile;
    readonly checksum: ReleaseEvidenceFile;
  };
}

export interface ReleaseEvidenceFile {
  readonly path: string;
  readonly name: string;
  readonly digest: string;
}

export interface ObservedRelease {
  readonly releaseId: number;
  readonly tagName: string;
  readonly headSha: string;
  readonly isDraft: boolean;
  readonly isPrerelease: boolean;
  readonly isImmutable: boolean;
  readonly repositoryImmutable: boolean;
  readonly assets: readonly { readonly name: string; readonly digest: string }[];
}

export interface ReleaseVerifier {
  inspectRelease(repository: string, tagName: string): Promise<ObservedRelease>;
  verifyRelease(repository: string, tagName: string): Promise<void>;
  verifyAsset(repository: string, tagName: string, path: string): Promise<void>;
}

export type ReleaseEvidenceResult =
  | {
      readonly schemaVersion: 1;
      readonly status: "planned";
      readonly version: string;
      readonly tagName: string;
      readonly headSha: string;
      readonly requiredFiles: 3;
      readonly verification: {
        readonly immutableRelease: true;
        readonly releaseAttestation: true;
        readonly assetAttestations: 3;
      };
    }
  | {
      readonly schemaVersion: 1;
      readonly status: "verified";
      readonly version: string;
      readonly tagName: string;
      readonly headSha: string;
      readonly releaseId: number;
      readonly artifactDigest: string;
      readonly sbomDigest: string;
      readonly checksumDigest: string;
      readonly verification: {
        readonly repositoryImmutable: true;
        readonly releaseImmutable: true;
        readonly releaseAttestation: true;
        readonly assetAttestations: 3;
      };
    };

export type ReleaseEvidenceErrorCode =
  | "release_asset_attestation_invalid"
  | "release_asset_digest_mismatch"
  | "release_asset_invalid"
  | "release_checksum_invalid"
  | "release_contract_invalid"
  | "release_immutable_required"
  | "release_observation_invalid"
  | "release_scope_denied"
  | "release_signature_invalid"
  | "release_source_mismatch"
  | "release_verifier_unavailable";

export class ReleaseEvidenceError extends Error {
  override readonly name = "ReleaseEvidenceError";

  constructor(readonly code: ReleaseEvidenceErrorCode) {
    super("release evidence rejected");
  }
}

function files(input: ReleaseEvidenceInput): readonly ReleaseEvidenceFile[] {
  return [input.files.artifact, input.files.sbom, input.files.checksum];
}

function assertInput(input: ReleaseEvidenceInput): void {
  if (
    input.schemaVersion !== 1 ||
    input.repository.disposition !== "in_scope" ||
    input.repository.isFork ||
    input.repository.isArchived
  ) throw new ReleaseEvidenceError("release_scope_denied");
  if (
    !repositoryPattern.test(input.repository.nameWithOwner) ||
    !tagPattern.test(input.release.tagName) ||
    input.release.tagName !== `v${input.release.version}` ||
    !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(input.release.version) ||
    !/^[0-9a-f]{40}$/u.test(input.release.headSha)
  ) throw new ReleaseEvidenceError("release_contract_invalid");

  const names = new Set<string>();
  for (const file of files(input)) {
    if (
      isAbsolute(file.path) ||
      file.path.includes("\\") ||
      file.path.split("/").some((part) => part.length === 0 || part === "." || part === "..") ||
      basename(file.path) !== file.name ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(file.name) ||
      !digestPattern.test(file.digest) ||
      names.has(file.name)
    ) throw new ReleaseEvidenceError("release_contract_invalid");
    names.add(file.name);
  }
}

function plannedResult(input: ReleaseEvidenceInput): ReleaseEvidenceResult {
  return {
    schemaVersion: 1,
    status: "planned",
    version: input.release.version,
    tagName: input.release.tagName,
    headSha: input.release.headSha,
    requiredFiles: 3,
    verification: {
      immutableRelease: true,
      releaseAttestation: true,
      assetAttestations: 3,
    },
  };
}

export function planReleaseEvidence(input: ReleaseEvidenceInput): ReleaseEvidenceResult {
  assertInput(input);
  return plannedResult(input);
}

async function assertSafeFile(root: string, path: string, maximumBytes: number): Promise<string> {
  const candidate = resolve(root, path);
  const relativePath = relative(root, candidate);
  if (relativePath.startsWith(`..${sep}`) || relativePath === ".." || isAbsolute(relativePath)) {
    throw new ReleaseEvidenceError("release_asset_invalid");
  }

  let parent = dirname(candidate);
  while (parent !== root) {
    const metadata = await lstat(parent).catch(() => undefined);
    if (metadata === undefined || !metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new ReleaseEvidenceError("release_asset_invalid");
    }
    const next = dirname(parent);
    if (next === parent) throw new ReleaseEvidenceError("release_asset_invalid");
    parent = next;
  }

  const metadata = await lstat(candidate).catch(() => undefined);
  if (
    metadata === undefined ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size <= 0 ||
    metadata.size > maximumBytes ||
    (await realpath(candidate)) !== candidate
  ) throw new ReleaseEvidenceError("release_asset_invalid");
  return candidate;
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolveHash, rejectHash) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk: Buffer) => hash.update(chunk));
    stream.once("error", rejectHash);
    stream.once("end", resolveHash);
  });
  return `sha256:${hash.digest("hex")}`;
}

function assertObservation(input: ReleaseEvidenceInput, observed: ObservedRelease): void {
  if (
    !Number.isSafeInteger(observed.releaseId) ||
    observed.releaseId <= 0 ||
    observed.tagName !== input.release.tagName
  ) throw new ReleaseEvidenceError("release_observation_invalid");
  if (observed.headSha !== input.release.headSha) {
    throw new ReleaseEvidenceError("release_source_mismatch");
  }
  if (
    observed.isDraft ||
    observed.isPrerelease ||
    !observed.isImmutable ||
    !observed.repositoryImmutable
  ) throw new ReleaseEvidenceError("release_immutable_required");

  for (const expected of files(input)) {
    const matching = observed.assets.filter(({ name }) => name === expected.name);
    if (matching.length !== 1 || matching[0]?.digest !== expected.digest) {
      throw new ReleaseEvidenceError("release_asset_digest_mismatch");
    }
  }
}

export async function auditReleaseEvidence(
  input: ReleaseEvidenceInput,
  workingDirectory: string,
  verifier: ReleaseVerifier,
): Promise<ReleaseEvidenceResult> {
  assertInput(input);
  const root = await realpath(resolve(workingDirectory)).catch(() => {
    throw new ReleaseEvidenceError("release_asset_invalid");
  });
  const paths = {
    artifact: await assertSafeFile(root, input.files.artifact.path, 2 * 1024 * 1024 * 1024),
    sbom: await assertSafeFile(root, input.files.sbom.path, 50 * 1024 * 1024),
    checksum: await assertSafeFile(root, input.files.checksum.path, 1024),
  };
  const [artifactDigest, sbomDigest, checksumDigest] = await Promise.all([
    sha256(paths.artifact),
    sha256(paths.sbom),
    sha256(paths.checksum),
  ]);
  if (
    artifactDigest !== input.files.artifact.digest ||
    sbomDigest !== input.files.sbom.digest ||
    checksumDigest !== input.files.checksum.digest
  ) throw new ReleaseEvidenceError("release_asset_digest_mismatch");

  const checksum = await readFile(paths.checksum, "utf8");
  if (checksum !== `${artifactDigest.slice("sha256:".length)}  ${input.files.artifact.name}\n`) {
    throw new ReleaseEvidenceError("release_checksum_invalid");
  }

  const observed = await verifier.inspectRelease(
    input.repository.nameWithOwner,
    input.release.tagName,
  );
  assertObservation(input, observed);
  await verifier.verifyRelease(input.repository.nameWithOwner, input.release.tagName);
  for (const path of [paths.artifact, paths.sbom, paths.checksum]) {
    await verifier.verifyAsset(input.repository.nameWithOwner, input.release.tagName, path);
  }
  const finalDigests = await Promise.all([
    sha256(paths.artifact),
    sha256(paths.sbom),
    sha256(paths.checksum),
  ]);
  if (
    finalDigests[0] !== artifactDigest ||
    finalDigests[1] !== sbomDigest ||
    finalDigests[2] !== checksumDigest
  ) throw new ReleaseEvidenceError("release_asset_digest_mismatch");
  return {
    schemaVersion: 1,
    status: "verified",
    version: input.release.version,
    tagName: input.release.tagName,
    headSha: input.release.headSha,
    releaseId: observed.releaseId,
    artifactDigest,
    sbomDigest,
    checksumDigest,
    verification: {
      repositoryImmutable: true,
      releaseImmutable: true,
      releaseAttestation: true,
      assetAttestations: 3,
    },
  };
}

interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
}

export class GitHubCliReleaseVerifier implements ReleaseVerifier {
  readonly #token: string;
  readonly #path: string;

  constructor(environment: NodeJS.ProcessEnv) {
    const token = environment["FLAMA_GITHUB_APP_INSTALLATION_TOKEN"];
    if (token === undefined || !/^ghs_[A-Za-z0-9]{36,255}$/u.test(token)) {
      throw new ReleaseEvidenceError("release_verifier_unavailable");
    }
    this.#token = token;
    this.#path = environment["PATH"] ?? "";
  }

  async #run(args: readonly string[], capture: boolean): Promise<string> {
    const result = await new Promise<ProcessResult>((resolveProcess) => {
      const child = spawn("gh", [...args], {
        env: {
          PATH: this.#path,
          GH_TOKEN: this.#token,
          GH_PROMPT_DISABLED: "1",
          NO_COLOR: "1",
        },
        shell: false,
        stdio: ["ignore", capture ? "pipe" : "ignore", "ignore"],
      });
      let stdout = "";
      let exceeded = false;
      if (capture && child.stdout !== null) {
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          if (stdout.length + chunk.length > 1024 * 1024) {
            exceeded = true;
            child.kill("SIGTERM");
          } else {
            stdout += chunk;
          }
        });
      }
      const timeout = setTimeout(() => child.kill("SIGTERM"), 30_000);
      child.once("error", () => {
        clearTimeout(timeout);
        resolveProcess({ exitCode: 127, stdout: "" });
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timeout);
        const exitCode = exceeded ? 125 : signal === null && code !== null ? code : 124;
        resolveProcess({ exitCode, stdout });
      });
    });
    if (result.exitCode !== 0) throw new ReleaseEvidenceError("release_signature_invalid");
    return result.stdout;
  }

  async inspectRelease(repository: string, tagName: string): Promise<ObservedRelease> {
    const endpointRepository = repository.split("/").map(encodeURIComponent).join("/");
    const encodedTag = encodeURIComponent(tagName);
    try {
      const [settingSource, releaseSource, commitSource] = await Promise.all([
        this.#run([
          "api", "--method", "GET", "-H", `X-GitHub-Api-Version:${githubApiVersion}`,
          `repos/${endpointRepository}/immutable-releases`,
        ], true),
        this.#run([
          "api", "--method", "GET", "-H", `X-GitHub-Api-Version:${githubApiVersion}`,
          `repos/${endpointRepository}/releases/tags/${encodedTag}`,
        ], true),
        this.#run([
          "api", "--method", "GET", "-H", `X-GitHub-Api-Version:${githubApiVersion}`,
          `repos/${endpointRepository}/commits/${encodedTag}`,
        ], true),
      ]);
      const setting: unknown = JSON.parse(settingSource);
      const release: unknown = JSON.parse(releaseSource);
      const commit: unknown = JSON.parse(commitSource);
      if (
        typeof setting !== "object" || setting === null || Reflect.get(setting, "enabled") !== true ||
        typeof release !== "object" || release === null ||
        typeof commit !== "object" || commit === null
      ) throw new ReleaseEvidenceError("release_observation_invalid");
      const rawAssets = Reflect.get(release, "assets");
      if (!Array.isArray(rawAssets)) throw new ReleaseEvidenceError("release_observation_invalid");
      const assets = rawAssets.map((asset: unknown) => {
        if (typeof asset !== "object" || asset === null) {
          throw new ReleaseEvidenceError("release_observation_invalid");
        }
        const name = Reflect.get(asset, "name");
        const digest = Reflect.get(asset, "digest");
        if (typeof name !== "string" || typeof digest !== "string" || !digestPattern.test(digest)) {
          throw new ReleaseEvidenceError("release_observation_invalid");
        }
        return { name, digest };
      });
      const releaseId = Reflect.get(release, "id");
      const observedTagName = Reflect.get(release, "tag_name");
      const headSha = Reflect.get(commit, "sha");
      const isDraft = Reflect.get(release, "draft");
      const isPrerelease = Reflect.get(release, "prerelease");
      const isImmutable = Reflect.get(release, "immutable");
      if (
        typeof releaseId !== "number" ||
        typeof observedTagName !== "string" ||
        typeof headSha !== "string" ||
        typeof isDraft !== "boolean" ||
        typeof isPrerelease !== "boolean" ||
        typeof isImmutable !== "boolean"
      ) throw new ReleaseEvidenceError("release_observation_invalid");
      const observed: ObservedRelease = {
        releaseId,
        tagName: observedTagName,
        headSha,
        isDraft,
        isPrerelease,
        isImmutable,
        repositoryImmutable: true,
        assets,
      };
      return observed;
    } catch (error) {
      if (error instanceof ReleaseEvidenceError) throw error;
      throw new ReleaseEvidenceError("release_observation_invalid");
    }
  }

  async verifyRelease(repository: string, tagName: string): Promise<void> {
    await this.#run(["release", "verify", tagName, "--repo", repository, "--format", "json"], false);
  }

  async verifyAsset(repository: string, tagName: string, path: string): Promise<void> {
    try {
      await this.#run(
        ["release", "verify-asset", tagName, path, "--repo", repository, "--format", "json"],
        false,
      );
    } catch {
      throw new ReleaseEvidenceError("release_asset_attestation_invalid");
    }
  }
}
