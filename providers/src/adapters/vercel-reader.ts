import type { VercelCredential, VercelDeployment, VercelDeploymentReader } from "./vercel.js";

/**
 * Reads a deployment record through the documented endpoint
 * `GET /v13/deployments/{idOrUrl}`, which returns `readyState`, `target`, and the
 * `meta` values recorded at deploy time. Error bodies are never surfaced, in line
 * with the platform's identifier-minimized output rules.
 */

type FetchImplementation = (input: string | URL, init?: RequestInit) => Promise<Response>;

const apiBase = "https://api.vercel.com";
const maximumResponseBytes = 1024 * 1024;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deploymentIdentifier(idOrUrl: string): string {
  // A deployment URL is accepted for convenience; only its hostname identifies the
  // deployment, and a bare identifier must not be able to traverse the API path.
  let candidate = idOrUrl;
  if (candidate.startsWith("https://") || candidate.startsWith("http://")) {
    try {
      candidate = new URL(candidate).hostname;
    } catch {
      throw new Error("vercel deployment identifier is invalid");
    }
  }
  if (!identifierPattern.test(candidate)) throw new Error("vercel deployment identifier is invalid");
  return candidate;
}

export class VercelRestDeploymentReader implements VercelDeploymentReader {
  constructor(
    private readonly credential: VercelCredential,
    private readonly fetchImplementation: FetchImplementation = fetch,
    private readonly slug?: string,
  ) {}

  async read(idOrUrl: string): Promise<VercelDeployment> {
    const identifier = deploymentIdentifier(idOrUrl);
    const query = this.slug === undefined ? "" : `?${new URLSearchParams({ slug: this.slug }).toString()}`;

    let response: Response;
    try {
      response = await this.fetchImplementation(
        `${apiBase}/v13/deployments/${encodeURIComponent(identifier)}${query}`,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${this.credential.reveal()}`,
          },
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch {
      throw new Error("vercel deployment read failed");
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error("vercel deployment read failed");
    }

    let source: string;
    try {
      source = await response.text();
    } catch {
      throw new Error("vercel deployment read failed");
    }
    if (Buffer.byteLength(source, "utf8") > maximumResponseBytes) {
      throw new Error("vercel deployment response is too large");
    }

    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch {
      throw new Error("vercel deployment response is not JSON");
    }
    if (
      !isRecord(value) || typeof value["url"] !== "string" || typeof value["readyState"] !== "string" ||
      (value["target"] !== null && value["target"] !== "production" && value["target"] !== "staging") ||
      !isRecord(value["meta"]) ||
      Object.values(value["meta"]).some((entry) => typeof entry !== "string")
    ) throw new Error("vercel deployment response is missing required fields");

    return {
      url: value["url"],
      readyState: value["readyState"],
      target: value["target"],
      meta: value["meta"] as Readonly<Record<string, string>>,
    };
  }
}
