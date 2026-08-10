import { createSign } from "node:crypto";

/**
 * Mints the short-lived GitHub App installation token that `publish-check`
 * consumes as `FLAMA_GITHUB_APP_INSTALLATION_TOKEN`.
 *
 * Nothing produced that token before this module existed: the platform read it
 * and the operations note deferred its creation to "Phase 3", so preflight
 * publication could never run outside a dry run. This closes that gap without
 * widening any authority — the minted token is scoped down to the single target
 * repository and to `checks: write`, so it cannot be used against another
 * repository even if it leaks within its lifetime.
 *
 * The App private key never leaves this process, is never logged, and the token
 * is returned inside a wrapper that redacts itself when serialised or inspected.
 */

const githubApiVersion = "2026-03-10" as const;

/** Ten minutes is GitHub's hard ceiling for an App JWT; nine keeps clock skew safe. */
const jwtLifetimeSeconds = 540;
const clockSkewSeconds = 60;

export type GitHubAppTokenErrorCode =
  | "app_credentials_unavailable"
  | "app_installation_not_found"
  | "app_permission_insufficient"
  | "app_repository_out_of_scope"
  | "app_request_failed"
  | "app_response_invalid";

export class GitHubAppTokenError extends Error {
  override readonly name = "GitHubAppTokenError";

  constructor(readonly code: GitHubAppTokenErrorCode) {
    super("github app token minting rejected");
  }
}

/**
 * Holds the token without letting it reach a log line, a JSON payload or an
 * inspected object. Mirrors the wrapper `publish-check` already uses.
 */
export class MintedInstallationToken {
  readonly #value: string;

  constructor(value: string, readonly expiresAt: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return "[REDACTED]";
  }

  toString(): string {
    return "MintedInstallationToken([REDACTED])";
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "MintedInstallationToken([REDACTED])";
  }
}

type FetchImplementation = typeof fetch;
type Environment = Readonly<Record<string, string | undefined>>;

/**
 * The owner segment selects the credential, so a repository can only ever be
 * addressed with its own owner's App. Keeping this a closed mapping means an
 * unexpected owner fails closed rather than falling back to some default App.
 */
const credentialSuffixByOwner: Readonly<Record<string, string>> = {
  maxbec: "MAXBEC",
  navigaite: "NAVIGAITE",
  "edilio-app": "EDILIO",
};

interface AppCredentials {
  readonly appId: string;
  readonly privateKey: string;
}

function readCredentials(environment: Environment, owner: string): AppCredentials {
  const suffix = credentialSuffixByOwner[owner];
  if (suffix === undefined) throw new GitHubAppTokenError("app_credentials_unavailable");

  const appId = environment[`FLAMA_GITHUB_APP_ID_${suffix}`];
  const privateKey = environment[`FLAMA_GITHUB_APP_PRIVATE_KEY_${suffix}`];
  if (
    appId === undefined || !/^[0-9]{1,20}$/u.test(appId) ||
    privateKey === undefined || !privateKey.includes("PRIVATE KEY")
  ) {
    throw new GitHubAppTokenError("app_credentials_unavailable");
  }
  return { appId, privateKey };
}

function base64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function appJwt(credentials: AppCredentials, nowSeconds: number): string {
  const header = base64Url({ alg: "RS256", typ: "JWT" });
  const payload = base64Url({
    iat: nowSeconds - clockSkewSeconds,
    exp: nowSeconds + jwtLifetimeSeconds,
    iss: credentials.appId,
  });
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  let signature: string;
  try {
    signature = signer.sign(credentials.privateKey, "base64url");
  } catch {
    // A malformed key must not surface OpenSSL internals.
    throw new GitHubAppTokenError("app_credentials_unavailable");
  }
  return `${header}.${payload}.${signature}`;
}

async function requestJson(
  fetchImplementation: FetchImplementation,
  path: string,
  token: string,
  init?: { readonly method: "POST"; readonly body: unknown },
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImplementation(`https://api.github.com${path}`, {
      method: init?.method ?? "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "flama-delivery-ctl",
        "X-GitHub-Api-Version": githubApiVersion,
        ...(init === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(init === undefined ? {} : { body: JSON.stringify(init.body) }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new GitHubAppTokenError("app_request_failed");
  }
  if (response.status === 404) throw new GitHubAppTokenError("app_installation_not_found");
  if (response.status !== 200 && response.status !== 201) {
    // Never read or echo a GitHub error body: it can carry the request context.
    await response.body?.cancel();
    throw new GitHubAppTokenError("app_request_failed");
  }
  try {
    return await response.json();
  } catch {
    throw new GitHubAppTokenError("app_response_invalid");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface MintInstallationTokenInput {
  /** `owner/name`, exactly as the check will be published against. */
  readonly repository: string;
  readonly environment: Environment;
  /**
   * Defaults to `checks: write`, which is all publication needs. Fetching a
   * head needs `contents: read` instead — separate tokens rather than one that
   * can do both, so neither carries authority it has no use for.
   */
  readonly permissions?: Readonly<Record<string, string>>;
  readonly fetchImplementation?: FetchImplementation;
  readonly now?: () => Date;
}

/**
 * Returns a token that can write checks on `repository` and nothing else.
 *
 * Two scope reductions are requested at mint time rather than assumed: the
 * token is bound to the single repository, and to `checks: write` alone. GitHub
 * answers with the permissions it actually granted, and a grant narrower than
 * requested fails closed here rather than surfacing later as an opaque 403 from
 * the publish call.
 */
export async function mintInstallationToken(
  input: MintInstallationTokenInput,
): Promise<MintedInstallationToken> {
  const fetchImplementation = input.fetchImplementation ?? fetch;
  const [owner, name, ...rest] = input.repository.split("/");
  if (owner === undefined || name === undefined || name.length === 0 || rest.length > 0) {
    throw new GitHubAppTokenError("app_repository_out_of_scope");
  }

  const permissions = input.permissions ?? { checks: "write" };
  const credentials = readCredentials(input.environment, owner);
  const nowSeconds = Math.floor((input.now?.() ?? new Date()).getTime() / 1_000);
  const jwt = appJwt(credentials, nowSeconds);

  const installation = await requestJson(
    fetchImplementation,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/installation`,
    jwt,
  );
  if (!isRecord(installation) || typeof installation["id"] !== "number") {
    throw new GitHubAppTokenError("app_response_invalid");
  }

  const minted = await requestJson(
    fetchImplementation,
    `/app/installations/${installation["id"]}/access_tokens`,
    jwt,
    {
      method: "POST",
      body: { repositories: [name], permissions },
    },
  );
  if (
    !isRecord(minted) || typeof minted["token"] !== "string" || minted["token"].length === 0 ||
    typeof minted["expires_at"] !== "string"
  ) {
    throw new GitHubAppTokenError("app_response_invalid");
  }
  const granted = minted["permissions"];
  if (
    !isRecord(granted) ||
    Object.entries(permissions).some(([key, value]) => granted[key] !== value)
  ) {
    throw new GitHubAppTokenError("app_permission_insufficient");
  }

  return new MintedInstallationToken(minted["token"], minted["expires_at"]);
}

/**
 * Lists the repositories an owner's App is installed on, and the open pull
 * request heads in each.
 *
 * Discovery deliberately mints its own token with `metadata` and
 * `pull_requests` read and nothing else. The publishing token is scoped to one
 * repository and carries `checks: write`; reusing it here would mean holding
 * write authority across every repository merely to find out what exists.
 */
export interface OpenPullRequestHead {
  readonly repository: string;
  readonly number: number;
  readonly headSha: string;
  readonly baseSha: string;
  readonly isFork: boolean;
  /** True when an app-authored Paperclip Preflight already passed for this head. */
  readonly hasPreflight: boolean;
}

/** A repository carries `.flama/platform-lock.json` only once it has adopted the profile. */
async function isPlatformManaged(
  fetchImplementation: FetchImplementation,
  repository: string,
  token: string,
): Promise<boolean> {
  try {
    await requestJson(
      fetchImplementation,
      `/repos/${repository}/contents/.flama/platform-lock.json`,
      token,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * A head already carrying a successful app-authored preflight needs no work.
 * The app slug is checked as well as the name: only the owner's own App may
 * satisfy the gate, so a same-named check from anything else must not count.
 */
async function hasAppPreflight(
  fetchImplementation: FetchImplementation,
  repository: string,
  headSha: string,
  token: string,
  appSlug: string,
): Promise<boolean> {
  let runs: unknown;
  try {
    runs = await requestJson(
      fetchImplementation,
      `/repos/${repository}/commits/${headSha}/check-runs?per_page=100`,
      token,
    );
  } catch {
    return false;
  }
  if (!isRecord(runs) || !Array.isArray(runs["check_runs"])) return false;
  return runs["check_runs"].some(
    (run) =>
      isRecord(run) && run["name"] === "Paperclip Preflight" && run["conclusion"] === "success" &&
      isRecord(run["app"]) && run["app"]["slug"] === appSlug &&
      typeof run["external_id"] === "string" &&
      /^paperclip-preflight:sha256:[0-9a-f]{64}$/u.test(run["external_id"]),
  );
}

export async function discoverOpenPullRequests(
  owner: string,
  appSlug: string,
  environment: Environment,
  fetchImplementation: FetchImplementation = fetch,
  now: () => Date = () => new Date(),
): Promise<readonly OpenPullRequestHead[]> {
  const credentials = readCredentials(environment, owner);
  const jwt = appJwt(credentials, Math.floor(now().getTime() / 1_000));

  const installations = await requestJson(fetchImplementation, "/app/installations", jwt);
  if (!Array.isArray(installations)) throw new GitHubAppTokenError("app_response_invalid");
  const installation = installations.find(
    (candidate) =>
      isRecord(candidate) && isRecord(candidate["account"]) && candidate["account"]["login"] === owner,
  );
  if (!isRecord(installation) || typeof installation["id"] !== "number") {
    throw new GitHubAppTokenError("app_installation_not_found");
  }

  const minted = await requestJson(
    fetchImplementation,
    `/app/installations/${installation["id"]}/access_tokens`,
    jwt,
    {
      method: "POST",
      // contents:read is needed only to tell a managed repository from an
      // unmanaged one; see the platform-lock probe below.
      body: {
        permissions: {
          metadata: "read",
          pull_requests: "read",
          contents: "read",
          // checks:read lets a head that already carries a valid preflight be
          // skipped before the expensive clone-and-run, which is what keeps a
          // recurring sweep near-idle instead of rebuilding every open head.
          checks: "read",
        },
      },
    },
  );
  if (!isRecord(minted) || typeof minted["token"] !== "string") {
    throw new GitHubAppTokenError("app_response_invalid");
  }
  const token = minted["token"];

  const repositories = await requestJson(
    fetchImplementation,
    "/installation/repositories?per_page=100",
    token,
  );
  if (!isRecord(repositories) || !Array.isArray(repositories["repositories"])) {
    throw new GitHubAppTokenError("app_response_invalid");
  }

  const heads: OpenPullRequestHead[] = [];
  for (const entry of repositories["repositories"]) {
    if (!isRecord(entry) || typeof entry["full_name"] !== "string") continue;
    if (entry["archived"] === true || entry["disabled"] === true) continue;
    const fullName = entry["full_name"];
    // The App is installed on every repository the owner chose, most of which
    // never adopted the delivery profile. Running preflight against those would
    // fail on a missing ./scripts/delivery and publish nothing but noise, so
    // the platform lock decides what is in scope.
    if (!(await isPlatformManaged(fetchImplementation, fullName, token))) continue;
    const pulls = await requestJson(
      fetchImplementation,
      `/repos/${fullName}/pulls?state=open&per_page=100`,
      token,
    );
    if (!Array.isArray(pulls)) continue;
    for (const pull of pulls) {
      if (!isRecord(pull) || typeof pull["number"] !== "number") continue;
      const head = pull["head"];
      const base = pull["base"];
      if (!isRecord(head) || !isRecord(base)) continue;
      if (typeof head["sha"] !== "string" || typeof base["sha"] !== "string") continue;
      const headRepository = head["repo"];
      heads.push({
        repository: fullName,
        number: pull["number"],
        headSha: head["sha"],
        baseSha: base["sha"],
        hasPreflight: await hasAppPreflight(fetchImplementation, fullName, head["sha"], token, appSlug),
        // A head from another repository is a fork contribution; publication
        // refuses it later, but recording it keeps the reason visible.
        isFork: !isRecord(headRepository) || headRepository["full_name"] !== fullName,
      });
    }
  }
  return heads;
}
