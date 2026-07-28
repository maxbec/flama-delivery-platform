import { inspect } from "node:util";

const githubApiVersion = "2026-03-10" as const;
const integrationCheckName = "Paperclip Integration Smoke" as const;
const maximumResponseBytes = 1024 * 1024;

type DeliveryController =
  | "maxbec-delivery-controller"
  | "navigaite-delivery-controller"
  | "edilio-delivery-controller";

export interface PromotionInput {
  readonly schemaVersion: 1;
  readonly repository: {
    readonly nameWithOwner: string;
    readonly disposition: "in_scope";
    readonly mutationAllowed: true;
    readonly isFork: false;
    readonly isArchived: false;
  };
  readonly profile: "major";
  readonly publisher: {
    readonly controller: DeliveryController;
    readonly appSlug: string;
    readonly tokenScope: "single-repository-pull-requests-write";
    readonly apiVersion: typeof githubApiVersion;
  };
  readonly promotion: {
    readonly sourceBranch: "dev";
    readonly targetBranch: "main";
    readonly sourceSha: string;
    readonly targetSha: string;
    readonly integrationEvidenceDigest: string;
  };
}

export interface PromotionBranch {
  readonly name: "dev" | "main";
  readonly sha: string;
  readonly protected: boolean;
}

export interface BranchComparison {
  readonly status: "ahead" | "behind" | "diverged" | "identical";
  readonly aheadBy: number;
  readonly behindBy: number;
}

export interface IntegrationCheck {
  readonly id: number;
  readonly name: string;
  readonly headSha: string;
  readonly externalId: string | null;
  readonly status: string;
  readonly conclusion: string | null;
  readonly appSlug: string;
}

export interface PromotionPullRequest {
  readonly number: number;
  readonly state: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly authorLogin: string;
}

export interface PromotionRequest {
  readonly title: "chore: promote dev to main";
  readonly head: "dev";
  readonly base: "main";
  readonly body: string;
  readonly maintainerCanModify: false;
}

export interface PromotionClient {
  assertSingleRepositoryScope(repository: string): Promise<void>;
  getBranch(repository: string, branch: "dev" | "main"): Promise<PromotionBranch>;
  compareBranches(repository: string, baseSha: string, headSha: string): Promise<BranchComparison>;
  listIntegrationChecks(repository: string, headSha: string): Promise<readonly IntegrationCheck[]>;
  listPromotionPullRequests(repository: string): Promise<readonly PromotionPullRequest[]>;
  createPromotionPullRequest(
    repository: string,
    request: PromotionRequest,
  ): Promise<PromotionPullRequest>;
}

interface PromotionBaseResult {
  readonly schemaVersion: 1;
  readonly profile: "major";
  readonly sourceSha: string;
  readonly targetSha: string;
  readonly integrationEvidenceDigest: string;
  readonly check: {
    readonly name: typeof integrationCheckName;
    readonly externalId: string;
    readonly status: "completed";
    readonly conclusion: "success";
  };
}

export type PromotionResult =
  | (PromotionBaseResult & {
      readonly status: "planned";
      readonly promotion: {
        readonly sourceBranch: "dev";
        readonly targetBranch: "main";
        readonly action: "create_or_reuse";
      };
    })
  | (PromotionBaseResult & {
      readonly status: "published";
      readonly promotion: {
        readonly sourceBranch: "dev";
        readonly targetBranch: "main";
        readonly action: "created" | "reused";
        readonly pullRequestNumber: number;
      };
    });

export type PromotionErrorCode =
  | "github_request_failed"
  | "promotion_ancestry_invalid"
  | "promotion_branch_invalid"
  | "promotion_contract_invalid"
  | "promotion_evidence_invalid"
  | "promotion_identity_unavailable"
  | "promotion_pull_request_conflict"
  | "promotion_response_invalid"
  | "promotion_scope_denied"
  | "promotion_token_scope_invalid";

export class PromotionError extends Error {
  override readonly name = "PromotionError";

  constructor(readonly code: PromotionErrorCode) {
    super("promotion rejected");
  }
}

function expectedController(repository: string): DeliveryController | undefined {
  switch (repository.split("/", 1)[0]) {
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

function externalId(input: PromotionInput): string {
  return `paperclip-integration:${input.promotion.integrationEvidenceDigest}`;
}

function assertInput(input: PromotionInput): void {
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
  ) throw new PromotionError("promotion_scope_denied");

  const controller = expectedController(input.repository.nameWithOwner);
  if (
    input.schemaVersion !== 1 ||
    input.profile !== "major" ||
    !/^(?:maxbec|navigaite|edilio)\/[A-Za-z0-9._-]+$/u.test(input.repository.nameWithOwner) ||
    controller === undefined ||
    input.publisher.controller !== controller ||
    !/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/u.test(input.publisher.appSlug) ||
    input.publisher.tokenScope !== "single-repository-pull-requests-write" ||
    input.publisher.apiVersion !== githubApiVersion ||
    input.promotion.sourceBranch !== "dev" ||
    input.promotion.targetBranch !== "main" ||
    !/^[0-9a-f]{40}$/u.test(input.promotion.sourceSha) ||
    !/^[0-9a-f]{40}$/u.test(input.promotion.targetSha) ||
    input.promotion.sourceSha === input.promotion.targetSha ||
    !/^sha256:[0-9a-f]{64}$/u.test(input.promotion.integrationEvidenceDigest)
  ) throw new PromotionError("promotion_contract_invalid");
}

function baseResult(input: PromotionInput): PromotionBaseResult {
  return {
    schemaVersion: 1,
    profile: "major",
    sourceSha: input.promotion.sourceSha,
    targetSha: input.promotion.targetSha,
    integrationEvidenceDigest: input.promotion.integrationEvidenceDigest,
    check: {
      name: integrationCheckName,
      externalId: externalId(input),
      status: "completed",
      conclusion: "success",
    },
  };
}

export function planPromotion(input: PromotionInput): PromotionResult {
  assertInput(input);
  return {
    ...baseResult(input),
    status: "planned",
    promotion: {
      sourceBranch: "dev",
      targetBranch: "main",
      action: "create_or_reuse",
    },
  };
}

function isExactIntegrationCheck(
  check: IntegrationCheck,
  input: PromotionInput,
): boolean {
  return (
    Number.isSafeInteger(check.id) &&
    check.id > 0 &&
    check.name === integrationCheckName &&
    check.headSha === input.promotion.sourceSha &&
    check.externalId === externalId(input) &&
    check.status === "completed" &&
    check.conclusion === "success" &&
    check.appSlug === input.publisher.appSlug
  );
}

function isExactPromotionPullRequest(
  pullRequest: PromotionPullRequest,
  input: PromotionInput,
): boolean {
  return (
    Number.isSafeInteger(pullRequest.number) &&
    pullRequest.number > 0 &&
    pullRequest.state === "open" &&
    pullRequest.headBranch === "dev" &&
    pullRequest.baseBranch === "main" &&
    pullRequest.headSha === input.promotion.sourceSha &&
    pullRequest.baseSha === input.promotion.targetSha &&
    pullRequest.authorLogin === `${input.publisher.appSlug}[bot]`
  );
}

function promotionRequest(input: PromotionInput): PromotionRequest {
  return {
    title: "chore: promote dev to main",
    head: "dev",
    base: "main",
    body: [
      "Automated Major-profile promotion after exact-SHA integration evidence passed.",
      "",
      `- Source SHA: \`${input.promotion.sourceSha}\``,
      `- Target SHA: \`${input.promotion.targetSha}\``,
      `- Integration evidence: \`${input.promotion.integrationEvidenceDigest}\``,
    ].join("\n"),
    maintainerCanModify: false,
  };
}

function publishedResult(
  input: PromotionInput,
  pullRequest: PromotionPullRequest,
  action: "created" | "reused",
): PromotionResult {
  if (!isExactPromotionPullRequest(pullRequest, input)) {
    throw new PromotionError("promotion_pull_request_conflict");
  }
  return {
    ...baseResult(input),
    status: "published",
    promotion: {
      sourceBranch: "dev",
      targetBranch: "main",
      action,
      pullRequestNumber: pullRequest.number,
    },
  };
}

export async function promote(
  input: PromotionInput,
  client: PromotionClient,
): Promise<PromotionResult> {
  assertInput(input);
  await client.assertSingleRepositoryScope(input.repository.nameWithOwner);
  const [source, target] = await Promise.all([
    client.getBranch(input.repository.nameWithOwner, "dev"),
    client.getBranch(input.repository.nameWithOwner, "main"),
  ]);
  if (
    source.name !== "dev" ||
    source.sha !== input.promotion.sourceSha ||
    !source.protected ||
    target.name !== "main" ||
    target.sha !== input.promotion.targetSha ||
    !target.protected
  ) throw new PromotionError("promotion_branch_invalid");

  const comparison = await client.compareBranches(
    input.repository.nameWithOwner,
    input.promotion.targetSha,
    input.promotion.sourceSha,
  );
  if (
    comparison.status !== "ahead" ||
    !Number.isSafeInteger(comparison.aheadBy) ||
    comparison.aheadBy < 1 ||
    comparison.behindBy !== 0
  ) throw new PromotionError("promotion_ancestry_invalid");

  const checks = (await client.listIntegrationChecks(
    input.repository.nameWithOwner,
    input.promotion.sourceSha,
  )).filter(({ externalId: value }) => value === externalId(input));
  if (checks.length !== 1 || checks[0] === undefined || !isExactIntegrationCheck(checks[0], input)) {
    throw new PromotionError("promotion_evidence_invalid");
  }

  const existing = await client.listPromotionPullRequests(input.repository.nameWithOwner);
  if (existing.length > 1) throw new PromotionError("promotion_pull_request_conflict");
  if (existing.length === 1) {
    const pullRequest = existing[0];
    if (pullRequest === undefined) throw new PromotionError("promotion_pull_request_conflict");
    return publishedResult(input, pullRequest, "reused");
  }

  try {
    const created = await client.createPromotionPullRequest(
      input.repository.nameWithOwner,
      promotionRequest(input),
    );
    return publishedResult(input, created, "created");
  } catch (error) {
    if (!(error instanceof PromotionError) || error.code !== "github_request_failed") throw error;
    const raced = await client.listPromotionPullRequests(input.repository.nameWithOwner);
    if (raced.length !== 1 || raced[0] === undefined) throw error;
    return publishedResult(input, raced[0], "reused");
  }
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
  ) throw new PromotionError("promotion_identity_unavailable");
  return new SecretInstallationToken(value);
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new PromotionError("promotion_response_invalid");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.byteLength;
    if (size > maximumResponseBytes) {
      await reader.cancel();
      throw new PromotionError("promotion_response_invalid");
    }
    chunks.push(result.value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new PromotionError("promotion_response_invalid");
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PromotionError("promotion_response_invalid");
  }
  return value as Record<string, unknown>;
}

function remoteCheck(value: unknown): IntegrationCheck {
  const record = object(value);
  const app = object(record["app"]);
  const id = record["id"];
  const name = record["name"];
  const headSha = record["head_sha"];
  const rawExternalId = record["external_id"];
  const status = record["status"];
  const rawConclusion = record["conclusion"];
  const appSlug = app["slug"];
  if (
    typeof id !== "number" || !Number.isSafeInteger(id) || id < 1 ||
    typeof name !== "string" ||
    typeof headSha !== "string" || !/^[0-9a-f]{40}$/u.test(headSha) ||
    (rawExternalId !== null && typeof rawExternalId !== "string") ||
    typeof status !== "string" ||
    (rawConclusion !== null && typeof rawConclusion !== "string") ||
    typeof appSlug !== "string" || appSlug.length === 0
  ) throw new PromotionError("promotion_response_invalid");
  return {
    id,
    name,
    headSha,
    externalId: rawExternalId,
    status,
    conclusion: rawConclusion,
    appSlug,
  };
}

function remotePullRequest(value: unknown): PromotionPullRequest {
  const record = object(value);
  const head = object(record["head"]);
  const base = object(record["base"]);
  const user = object(record["user"]);
  const number = record["number"];
  const state = record["state"];
  const headBranch = head["ref"];
  const baseBranch = base["ref"];
  const headSha = head["sha"];
  const baseSha = base["sha"];
  const authorLogin = user["login"];
  if (
    typeof number !== "number" || !Number.isSafeInteger(number) || number < 1 ||
    typeof state !== "string" ||
    typeof headBranch !== "string" ||
    typeof baseBranch !== "string" ||
    typeof headSha !== "string" || !/^[0-9a-f]{40}$/u.test(headSha) ||
    typeof baseSha !== "string" || !/^[0-9a-f]{40}$/u.test(baseSha) ||
    typeof authorLogin !== "string" || authorLogin.length === 0
  ) throw new PromotionError("promotion_response_invalid");
  return { number, state, headBranch, baseBranch, headSha, baseSha, authorLogin };
}

export class GitHubRestPromotionClient implements PromotionClient {
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
        throw new PromotionError("github_request_failed");
      }
      return await boundedJson(response);
    } catch (error) {
      if (error instanceof PromotionError) throw error;
      throw new PromotionError("github_request_failed");
    }
  }

  #repositoryPath(repository: string): string {
    const [owner, name] = repository.split("/");
    return `/repos/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(name ?? "")}`;
  }

  async assertSingleRepositoryScope(repository: string): Promise<void> {
    const value = object(await this.#request("GET", "/installation/repositories?per_page=2"));
    const repositories = value["repositories"];
    if (
      value["total_count"] !== 1 ||
      !Array.isArray(repositories) ||
      repositories.length !== 1 ||
      object(repositories[0])["full_name"] !== repository
    ) throw new PromotionError("promotion_token_scope_invalid");
  }

  async getBranch(repository: string, branch: "dev" | "main"): Promise<PromotionBranch> {
    const value = object(await this.#request(
      "GET",
      `${this.#repositoryPath(repository)}/branches/${encodeURIComponent(branch)}`,
    ));
    const commit = object(value["commit"]);
    const name = value["name"];
    const sha = commit["sha"];
    const protectedBranch = value["protected"];
    if (
      (name !== "dev" && name !== "main") ||
      typeof sha !== "string" ||
      !/^[0-9a-f]{40}$/u.test(sha) ||
      typeof protectedBranch !== "boolean"
    ) throw new PromotionError("promotion_response_invalid");
    return { name, sha, protected: protectedBranch };
  }

  async compareBranches(
    repository: string,
    baseSha: string,
    headSha: string,
  ): Promise<BranchComparison> {
    const value = object(await this.#request(
      "GET",
      `${this.#repositoryPath(repository)}/compare/${baseSha}...${headSha}`,
    ));
    const status = value["status"];
    const aheadBy = value["ahead_by"];
    const behindBy = value["behind_by"];
    if (
      status !== "ahead" && status !== "behind" && status !== "diverged" && status !== "identical"
    ) throw new PromotionError("promotion_response_invalid");
    if (
      typeof aheadBy !== "number" || !Number.isSafeInteger(aheadBy) || aheadBy < 0 ||
      typeof behindBy !== "number" || !Number.isSafeInteger(behindBy) || behindBy < 0
    ) throw new PromotionError("promotion_response_invalid");
    return { status, aheadBy, behindBy };
  }

  async listIntegrationChecks(
    repository: string,
    headSha: string,
  ): Promise<readonly IntegrationCheck[]> {
    const path = `${this.#repositoryPath(repository)}/commits/${headSha}/check-runs?check_name=${encodeURIComponent(integrationCheckName)}&filter=all&per_page=100`;
    const value = object(await this.#request("GET", path));
    const checks = value["check_runs"];
    if (!Array.isArray(checks)) throw new PromotionError("promotion_response_invalid");
    return checks.map(remoteCheck);
  }

  async listPromotionPullRequests(repository: string): Promise<readonly PromotionPullRequest[]> {
    const owner = repository.split("/", 1)[0] ?? "";
    const query = new URLSearchParams({
      state: "open",
      head: `${owner}:dev`,
      base: "main",
      per_page: "2",
    });
    const value = await this.#request("GET", `${this.#repositoryPath(repository)}/pulls?${query}`);
    if (!Array.isArray(value)) throw new PromotionError("promotion_response_invalid");
    return value.map(remotePullRequest);
  }

  async createPromotionPullRequest(
    repository: string,
    request: PromotionRequest,
  ): Promise<PromotionPullRequest> {
    return remotePullRequest(await this.#request("POST", `${this.#repositoryPath(repository)}/pulls`, {
      title: request.title,
      head: request.head,
      base: request.base,
      body: request.body,
      maintainer_can_modify: request.maintainerCanModify,
    }));
  }
}
