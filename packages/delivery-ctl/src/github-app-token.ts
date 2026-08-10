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
      body: { repositories: [name], permissions: { checks: "write" } },
    },
  );
  if (
    !isRecord(minted) || typeof minted["token"] !== "string" || minted["token"].length === 0 ||
    typeof minted["expires_at"] !== "string"
  ) {
    throw new GitHubAppTokenError("app_response_invalid");
  }
  const permissions = minted["permissions"];
  if (!isRecord(permissions) || permissions["checks"] !== "write") {
    throw new GitHubAppTokenError("app_permission_insufficient");
  }

  return new MintedInstallationToken(minted["token"], minted["expires_at"]);
}
