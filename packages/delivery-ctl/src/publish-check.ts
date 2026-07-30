import { createHash } from "node:crypto";
import { inspect } from "node:util";

const checkName = "Paperclip Preflight" as const;
const maximumResponseBytes = 1024 * 1024;
const githubApiVersion = "2026-03-10" as const;

type DeliveryController =
  | "maxbec-delivery-controller"
  | "navigaite-delivery-controller"
  | "edilio-delivery-controller";

interface PreflightEvidenceCommand {
  readonly command: "./scripts/delivery buildable" | "./scripts/delivery affected";
  readonly status: "passed";
  readonly exitCode: 0;
  readonly evidenceDigest: string;
}

export interface SignedPreflightEvidence {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly runner: {
    readonly class: "paperclip_ephemeral";
    readonly id: string;
    readonly controller: DeliveryController;
  };
  readonly commands: readonly PreflightEvidenceCommand[];
  readonly releaseImpact: "none" | "patch" | "minor" | "major";
  readonly signature: {
    readonly issuer: string;
    readonly subject: string;
    readonly algorithm: "sigstore-keyless" | "github-app";
    readonly payloadDigest: string;
    readonly signedAt: string;
  };
}

export interface PublishCheckInput {
  readonly schemaVersion: 1;
  readonly repository: {
    readonly nameWithOwner: string;
    readonly disposition: "in_scope";
    readonly mutationAllowed: true;
    readonly isFork: false;
    readonly isArchived: false;
  };
  readonly publisher: {
    readonly controller: DeliveryController;
    readonly appSlug: string;
    readonly tokenScope: "single-repository-checks-write";
    readonly apiVersion: typeof githubApiVersion;
  };
  readonly evidence: SignedPreflightEvidence;
}

export interface GitHubCheckRequest {
  readonly name: typeof checkName;
  readonly headSha: string;
  readonly externalId: string;
  readonly status: "completed";
  readonly conclusion: "success";
  readonly completedAt: string;
  readonly output: {
    readonly title: "Paperclip preflight passed";
    readonly summary: string;
  };
}

export interface RemoteCheckRun {
  readonly id: number;
  readonly name: string;
  readonly headSha: string;
  readonly externalId: string | null;
  readonly status: string;
  readonly conclusion: string | null;
  readonly appSlug: string;
}

export interface GitHubCheckClient {
  assertSingleRepositoryScope(repository: string): Promise<void>;
  listCheckRuns(repository: string, headSha: string, name: string): Promise<readonly RemoteCheckRun[]>;
  createCheckRun(repository: string, request: GitHubCheckRequest): Promise<RemoteCheckRun>;
}

export type PublishCheckResult =
  | {
      readonly schemaVersion: 1;
      readonly status: "planned";
      readonly headSha: string;
      readonly evidenceDigest: string;
      readonly check: {
        readonly name: typeof checkName;
        readonly externalId: string;
        readonly status: "completed";
        readonly conclusion: "success";
      };
    }
  | {
      readonly schemaVersion: 1;
      readonly status: "published";
      readonly headSha: string;
      readonly evidenceDigest: string;
      readonly check: {
        readonly name: typeof checkName;
        readonly externalId: string;
        readonly status: "completed";
        readonly conclusion: "success";
      };
      readonly publication: {
        readonly checkRunId: number;
        readonly appSlug: string;
        readonly reused: boolean;
      };
    };

export type PublishCheckErrorCode =
  | "github_check_conflict"
  | "github_check_response_invalid"
  | "github_request_failed"
  | "publish_check_contract_mismatch"
  | "publish_check_digest_mismatch"
  | "publish_check_scope_denied"
  | "publish_check_signature_invalid"
  | "publisher_identity_unavailable"
  | "publisher_scope_invalid";

export class PublishCheckError extends Error {
  override readonly name = "PublishCheckError";

  constructor(readonly code: PublishCheckErrorCode) {
    super("check publication rejected");
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(Reflect.get(value, key))}`)
      .join(",")}}`;
  }
  throw new PublishCheckError("publish_check_signature_invalid");
}

function signaturePayload(evidence: SignedPreflightEvidence): Omit<SignedPreflightEvidence, "signature"> {
  return {
    schemaVersion: evidence.schemaVersion,
    repository: evidence.repository,
    headSha: evidence.headSha,
    baseSha: evidence.baseSha,
    startedAt: evidence.startedAt,
    finishedAt: evidence.finishedAt,
    runner: evidence.runner,
    commands: evidence.commands,
    releaseImpact: evidence.releaseImpact,
  };
}

export function preflightPayloadDigest(evidence: SignedPreflightEvidence): string {
  return `sha256:${createHash("sha256").update(canonicalJson(signaturePayload(evidence))).digest("hex")}`;
}

function expectedController(repository: string): DeliveryController | undefined {
  const owner = repository.split("/", 1)[0];
  switch (owner) {
    case "maxbec":
      return "maxbec-delivery-controller";
    case "navigaite":
      return "navigaite-delivery-controller";
    case "edilio":
      return "edilio-delivery-controller";
    default:
      return undefined;
  }
}

function assertPublishable(input: PublishCheckInput): string {
  const repositoryState = input.repository as {
    readonly disposition: string;
    readonly mutationAllowed: boolean;
    readonly isFork: boolean;
    readonly isArchived: boolean;
  };
  if (
    repositoryState.disposition !== "in_scope" ||
    !repositoryState.mutationAllowed ||
    repositoryState.isFork ||
    repositoryState.isArchived
  ) {
    throw new PublishCheckError("publish_check_scope_denied");
  }
  const controller = expectedController(input.repository.nameWithOwner);
  if (
    input.schemaVersion !== 1 ||
    !/^(?:maxbec|navigaite|edilio-app)\/[A-Za-z0-9._-]+$/u.test(input.repository.nameWithOwner) ||
    input.publisher.tokenScope !== "single-repository-checks-write" ||
    input.publisher.apiVersion !== githubApiVersion ||
    !/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/u.test(input.publisher.appSlug) ||
    input.evidence.repository !== input.repository.nameWithOwner ||
    controller === undefined ||
    input.publisher.controller !== controller ||
    input.evidence.runner.controller !== controller
  ) {
    throw new PublishCheckError("publish_check_contract_mismatch");
  }
  const started = Date.parse(input.evidence.startedAt);
  const finished = Date.parse(input.evidence.finishedAt);
  const signed = Date.parse(input.evidence.signature.signedAt);
  if (
    input.evidence.signature.algorithm !== "github-app" ||
    input.evidence.signature.issuer !== input.publisher.appSlug ||
    input.evidence.signature.subject !== controller ||
    !Number.isFinite(started) ||
    !Number.isFinite(finished) ||
    !Number.isFinite(signed) ||
    started > finished ||
    finished > signed ||
    !/^[0-9a-f]{40}$/u.test(input.evidence.headSha) ||
    !/^[0-9a-f]{40}$/u.test(input.evidence.baseSha) ||
    input.evidence.commands.length !== 2 ||
    input.evidence.commands[0]?.command !== "./scripts/delivery buildable" ||
    input.evidence.commands[1]?.command !== "./scripts/delivery affected" ||
    input.evidence.commands.some(
      (command) =>
        command.status !== "passed" ||
        command.exitCode !== 0 ||
        !/^sha256:[0-9a-f]{64}$/u.test(command.evidenceDigest),
    )
  ) {
    throw new PublishCheckError("publish_check_signature_invalid");
  }
  const digest = preflightPayloadDigest(input.evidence);
  if (digest !== input.evidence.signature.payloadDigest) {
    throw new PublishCheckError("publish_check_digest_mismatch");
  }
  return digest;
}

function checkRequest(evidence: SignedPreflightEvidence, digest: string): GitHubCheckRequest {
  return {
    name: checkName,
    headSha: evidence.headSha,
    externalId: `paperclip-preflight:${digest}`,
    status: "completed",
    conclusion: "success",
    completedAt: evidence.finishedAt,
    output: {
      title: "Paperclip preflight passed",
      summary: `Controller-signed buildable and affected evidence verified for the exact commit. Evidence digest: ${digest}.`,
    },
  };
}

function commonResult(evidence: SignedPreflightEvidence, digest: string, request: GitHubCheckRequest) {
  return {
    schemaVersion: 1 as const,
    headSha: evidence.headSha,
    evidenceDigest: digest,
    check: {
      name: request.name,
      externalId: request.externalId,
      status: request.status,
      conclusion: request.conclusion,
    },
  };
}

function isMatchingCheck(
  check: RemoteCheckRun,
  request: GitHubCheckRequest,
  expectedAppSlug: string,
): boolean {
  return (
    Number.isSafeInteger(check.id) &&
    check.id > 0 &&
    check.name === request.name &&
    check.headSha === request.headSha &&
    check.externalId === request.externalId &&
    check.status === request.status &&
    check.conclusion === request.conclusion &&
    check.appSlug === expectedAppSlug
  );
}

export function planPublishCheck(input: PublishCheckInput): PublishCheckResult {
  const digest = assertPublishable(input);
  const request = checkRequest(input.evidence, digest);
  return { ...commonResult(input.evidence, digest, request), status: "planned" };
}

export async function publishCheck(
  input: PublishCheckInput,
  client: GitHubCheckClient,
): Promise<PublishCheckResult> {
  const digest = assertPublishable(input);
  const request = checkRequest(input.evidence, digest);
  await client.assertSingleRepositoryScope(input.repository.nameWithOwner);
  const existing = (await client.listCheckRuns(
    input.repository.nameWithOwner,
    input.evidence.headSha,
    checkName,
  )).filter((check) => check.externalId === request.externalId);
  if (existing.length > 1) throw new PublishCheckError("github_check_conflict");
  if (existing.length === 1) {
    const check = existing[0];
    if (check === undefined || !isMatchingCheck(check, request, input.publisher.appSlug)) {
      throw new PublishCheckError("github_check_conflict");
    }
    return {
      ...commonResult(input.evidence, digest, request),
      status: "published",
      publication: { checkRunId: check.id, appSlug: check.appSlug, reused: true },
    };
  }

  const created = await client.createCheckRun(input.repository.nameWithOwner, request);
  if (!isMatchingCheck(created, request, input.publisher.appSlug)) {
    throw new PublishCheckError("github_check_response_invalid");
  }
  return {
    ...commonResult(input.evidence, digest, request),
    status: "published",
    publication: { checkRunId: created.id, appSlug: created.appSlug, reused: false },
  };
}

class SecretInstallationToken {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return "[REDACTED]";
  }

  toString(): string {
    return "[REDACTED]";
  }

  [inspect.custom](): string {
    return "SecretInstallationToken([REDACTED])";
  }
}

type FetchImplementation = typeof fetch;

function parseToken(environment: Readonly<Record<string, string | undefined>>): SecretInstallationToken {
  const value = environment["FLAMA_GITHUB_APP_INSTALLATION_TOKEN"];
  if (
    value === undefined ||
    value.length > 4_096 ||
    !/^ghs_[A-Za-z0-9._-]{4,4092}$/u.test(value)
  ) {
    throw new PublishCheckError("publisher_identity_unavailable");
  }
  return new SecretInstallationToken(value);
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new PublishCheckError("github_check_response_invalid");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.byteLength;
    if (size > maximumResponseBytes) {
      await reader.cancel();
      throw new PublishCheckError("github_check_response_invalid");
    }
    chunks.push(result.value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new PublishCheckError("github_check_response_invalid");
  }
}

function remoteCheckRun(value: unknown): RemoteCheckRun {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PublishCheckError("github_check_response_invalid");
  }
  const app = Reflect.get(value, "app");
  const parsed: RemoteCheckRun = {
    id: Reflect.get(value, "id") as number,
    name: Reflect.get(value, "name") as string,
    headSha: Reflect.get(value, "head_sha") as string,
    externalId: (Reflect.get(value, "external_id") ?? null) as string | null,
    status: Reflect.get(value, "status") as string,
    conclusion: (Reflect.get(value, "conclusion") ?? null) as string | null,
    appSlug:
      typeof app === "object" && app !== null ? (Reflect.get(app, "slug") as string) : "",
  };
  if (
    !Number.isSafeInteger(parsed.id) ||
    parsed.id < 1 ||
    typeof parsed.name !== "string" ||
    typeof parsed.headSha !== "string" ||
    !/^[0-9a-f]{40}$/u.test(parsed.headSha) ||
    (parsed.externalId !== null && typeof parsed.externalId !== "string") ||
    typeof parsed.status !== "string" ||
    (parsed.conclusion !== null && typeof parsed.conclusion !== "string") ||
    typeof parsed.appSlug !== "string" ||
    parsed.appSlug.length === 0
  ) {
    throw new PublishCheckError("github_check_response_invalid");
  }
  return parsed;
}

export class GitHubRestCheckClient implements GitHubCheckClient {
  readonly #token: SecretInstallationToken;

  constructor(
    environment: Readonly<Record<string, string | undefined>>,
    private readonly fetchImplementation: FetchImplementation = fetch,
  ) {
    this.#token = parseToken(environment);
  }

  async #request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    try {
      const response = await this.fetchImplementation(`https://api.github.com${path}`, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.#token.reveal()}`,
          "Content-Type": "application/json",
          "User-Agent": "flama-delivery-ctl",
          "X-GitHub-Api-Version": githubApiVersion,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      const expectedStatus = method === "POST" ? 201 : 200;
      if (response.status !== expectedStatus) {
        await response.body?.cancel();
        throw new PublishCheckError("github_request_failed");
      }
      return await boundedJson(response);
    } catch (error) {
      if (error instanceof PublishCheckError) throw error;
      throw new PublishCheckError("github_request_failed");
    }
  }

  async assertSingleRepositoryScope(repository: string): Promise<void> {
    const value = await this.#request("GET", "/installation/repositories?per_page=2");
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new PublishCheckError("publisher_scope_invalid");
    }
    const repositories = Reflect.get(value, "repositories");
    if (
      Reflect.get(value, "total_count") !== 1 ||
      !Array.isArray(repositories) ||
      repositories.length !== 1 ||
      typeof repositories[0] !== "object" ||
      repositories[0] === null ||
      Reflect.get(repositories[0], "full_name") !== repository
    ) {
      throw new PublishCheckError("publisher_scope_invalid");
    }
  }

  async listCheckRuns(repository: string, headSha: string, name: string): Promise<readonly RemoteCheckRun[]> {
    const [owner, repositoryName] = repository.split("/");
    const path = `/repos/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(repositoryName ?? "")}/commits/${headSha}/check-runs?check_name=${encodeURIComponent(name)}&filter=all&per_page=100`;
    const value = await this.#request("GET", path);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new PublishCheckError("github_check_response_invalid");
    }
    const checks = Reflect.get(value, "check_runs");
    if (!Array.isArray(checks)) throw new PublishCheckError("github_check_response_invalid");
    return checks.map(remoteCheckRun);
  }

  async createCheckRun(repository: string, request: GitHubCheckRequest): Promise<RemoteCheckRun> {
    const [owner, repositoryName] = repository.split("/");
    const value = await this.#request(
      "POST",
      `/repos/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(repositoryName ?? "")}/check-runs`,
      {
        name: request.name,
        head_sha: request.headSha,
        external_id: request.externalId,
        status: request.status,
        conclusion: request.conclusion,
        completed_at: request.completedAt,
        output: request.output,
      },
    );
    return remoteCheckRun(value);
  }
}
