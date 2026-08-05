import type {
  DigitalOceanAppClient,
  DigitalOceanAppSpec,
  DigitalOceanDeployment,
} from "./digitalocean-app.js";

/**
 * App Platform client limited to the four operations a deployment needs:
 * read the spec, pin the digest, create one deployment, and read its phase.
 * Error bodies are never surfaced, matching the platform's output rules.
 */

export interface DigitalOceanCredential {
  reveal(): string;
}

type FetchImplementation = (input: string | URL, init?: RequestInit) => Promise<Response>;

const apiBase = "https://api.digitalocean.com";
const maximumResponseBytes = 4 * 1024 * 1024;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function identifier(value: string): string {
  if (!identifierPattern.test(value)) throw new Error("digitalocean identifier is invalid");
  return value;
}

function appSpec(value: unknown): DigitalOceanAppSpec {
  if (
    !isRecord(value) || typeof value["name"] !== "string" || !Array.isArray(value["services"]) ||
    value["services"].some((service) =>
      !isRecord(service) || typeof service["name"] !== "string" || !isRecord(service["image"])
    )
  ) throw new Error("digitalocean app spec is missing required fields");
  return value as unknown as DigitalOceanAppSpec;
}

function deployment(value: unknown): DigitalOceanDeployment {
  if (!isRecord(value) || !isRecord(value["deployment"])) {
    throw new Error("digitalocean deployment envelope is missing");
  }
  const entry = value["deployment"];
  if (typeof entry["id"] !== "string" || typeof entry["phase"] !== "string") {
    throw new Error("digitalocean deployment is missing required fields");
  }
  return { id: entry["id"], phase: entry["phase"] };
}

export class DigitalOceanRestAppClient implements DigitalOceanAppClient {
  constructor(
    private readonly credential: DigitalOceanCredential,
    private readonly fetchImplementation: FetchImplementation = fetch,
  ) {}

  async #request(method: "GET" | "PUT" | "POST", path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImplementation(`${apiBase}${path}`, {
        method,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.credential.reveal()}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error("digitalocean request failed");
    }
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel();
      throw new Error("digitalocean request failed");
    }
    let source: string;
    try {
      source = await response.text();
    } catch {
      throw new Error("digitalocean request failed");
    }
    if (Buffer.byteLength(source, "utf8") > maximumResponseBytes) {
      throw new Error("digitalocean response is too large");
    }
    try {
      return JSON.parse(source) as unknown;
    } catch {
      throw new Error("digitalocean response is not JSON");
    }
  }

  async getApp(appId: string): Promise<{ readonly spec: DigitalOceanAppSpec }> {
    const value = await this.#request("GET", `/v2/apps/${encodeURIComponent(identifier(appId))}`);
    if (!isRecord(value) || !isRecord(value["app"])) {
      throw new Error("digitalocean app envelope is missing");
    }
    return { spec: appSpec(value["app"]["spec"]) };
  }

  async updateApp(appId: string, spec: DigitalOceanAppSpec): Promise<void> {
    // `update_all_source_versions` must be true. DigitalOcean documents that it
    // defaults to false and that only newly added sources are updated then, so a
    // changed image digest would be silently ignored and the app would keep
    // serving the previous image while the request still succeeded.
    await this.#request("PUT", `/v2/apps/${encodeURIComponent(identifier(appId))}`, {
      spec,
      update_all_source_versions: true,
    });
  }

  async createDeployment(appId: string): Promise<DigitalOceanDeployment> {
    // Providers must not rebuild source during deployment (plan section 14).
    return deployment(await this.#request(
      "POST",
      `/v2/apps/${encodeURIComponent(identifier(appId))}/deployments`,
      { force_build: false },
    ));
  }

  async getDeployment(appId: string, deploymentId: string): Promise<DigitalOceanDeployment> {
    return deployment(await this.#request(
      "GET",
      `/v2/apps/${encodeURIComponent(identifier(appId))}/deployments/${encodeURIComponent(identifier(deploymentId))}`,
    ));
  }
}
