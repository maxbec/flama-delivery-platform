import { SecretValue } from "../../bridge/src/config.js";
import {
  GovernanceError,
  type GitHubGovernanceReader,
  type GitHubWorkflowJob,
  type GitHubWorkflowRun,
  type GovernanceReaders,
  type PaperclipGovernanceReader,
  type PaperclipGovernanceSnapshot,
} from "./governance.js";

type ScopeKey = "maxbec" | "navigaite" | "edilio";
type Environment = Readonly<Record<string, string | undefined>>;
type FetchImplementation = (input: string | URL, init?: RequestInit) => Promise<Response>;

const scopeKeys = ["maxbec", "navigaite", "edilio"] as const;
const maximumResponseBytes = 2 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validCredential(value: string | undefined): value is string {
  return value !== undefined && value.length >= 20 && value.length <= 4_096 && !/[\r\n]/u.test(value);
}

function validGitHubCredential(value: string | undefined): value is string {
  return validCredential(value) && (
    /^ghs_[A-Za-z0-9]{20,255}$/u.test(value) || /^test-only-[A-Za-z0-9-]{10,255}$/u.test(value)
  );
}

function safePaperclipBase(value: string | undefined): string {
  if (value === undefined || value.length > 2_048 || /[\r\n]/u.test(value)) {
    throw new GovernanceError("governance_identity_unavailable");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GovernanceError("governance_identity_unavailable");
  }
  const loopback = url.protocol === "http:" && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !loopback) || url.username || url.password || url.search || url.hash) {
    throw new GovernanceError("governance_identity_unavailable");
  }
  return url.toString().replace(/\/+$/u, "");
}

class ReadOnlyJsonClient {
  constructor(
    private readonly apiBase: string,
    private readonly credential: SecretValue,
    private readonly fetchImplementation: FetchImplementation,
    private readonly github: boolean,
  ) {}

  async get(path: string): Promise<unknown> {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || /[\r\n]/u.test(path)) {
      throw new GovernanceError("governance_read_failed");
    }
    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.apiBase}${path}`, {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.credential.reveal()}`,
          "User-Agent": "flama-governance-controller/0.1.0",
          ...(this.github ? { "X-GitHub-Api-Version": "2026-03-10" } : {}),
        },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new GovernanceError("governance_read_failed");
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new GovernanceError("governance_read_failed");
    }
    const contentType = response.headers.get("content-type");
    const contentLength = response.headers.get("content-length");
    if (contentType === null || !/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/iu.test(contentType) ||
      (contentLength !== null && (!/^[0-9]+$/u.test(contentLength) || Number(contentLength) > maximumResponseBytes))) {
      await response.body?.cancel();
      throw new GovernanceError("governance_metadata_invalid");
    }
    let source: string;
    try {
      source = await response.text();
    } catch {
      throw new GovernanceError("governance_metadata_invalid");
    }
    if (Buffer.byteLength(source, "utf8") > maximumResponseBytes) {
      throw new GovernanceError("governance_metadata_invalid");
    }
    try {
      return JSON.parse(source) as unknown;
    } catch {
      throw new GovernanceError("governance_metadata_invalid");
    }
  }
}

function recordOrNull(value: unknown): Readonly<Record<string, unknown>> | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new GovernanceError("governance_metadata_invalid");
  return value;
}

export class PaperclipReadOnlyReader implements PaperclipGovernanceReader {
  readonly #client: ReadOnlyJsonClient;

  constructor(apiBase: string, credential: SecretValue, fetchImplementation: FetchImplementation = fetch) {
    this.#client = new ReadOnlyJsonClient(safePaperclipBase(apiBase), credential, fetchImplementation, false);
  }

  async readSnapshot(companyId: string): Promise<PaperclipGovernanceSnapshot> {
    if (!/^[0-9a-f-]{36}$/iu.test(companyId)) throw new GovernanceError("governance_input_invalid");
    const encoded = encodeURIComponent(companyId);
    const [companyValue, agentsValue, pipelinesValue] = await Promise.all([
      this.#client.get(`/api/companies/${encoded}`),
      this.#client.get(`/api/companies/${encoded}/agents`),
      this.#client.get(`/api/companies/${encoded}/pipelines`),
    ]);
    if (!isRecord(companyValue) || typeof companyValue["id"] !== "string" || typeof companyValue["name"] !== "string" ||
      (companyValue["status"] !== undefined && typeof companyValue["status"] !== "string") ||
      !Array.isArray(agentsValue) || !Array.isArray(pipelinesValue)) {
      throw new GovernanceError("governance_metadata_invalid");
    }
    const agents = agentsValue.map((value) => {
      if (!isRecord(value) || typeof value["id"] !== "string" || typeof value["companyId"] !== "string" ||
        typeof value["name"] !== "string" || typeof value["role"] !== "string" ||
        typeof value["adapterType"] !== "string" || !Number.isSafeInteger(value["budgetMonthlyCents"]) ||
        Number(value["budgetMonthlyCents"]) < 0 || typeof value["status"] !== "string" ||
        (value["desiredSkills"] !== undefined && !Array.isArray(value["desiredSkills"]))) {
        throw new GovernanceError("governance_metadata_invalid");
      }
      return {
        id: value["id"],
        companyId: value["companyId"],
        name: value["name"],
        role: value["role"],
        adapterType: value["adapterType"],
        budgetMonthlyCents: Number(value["budgetMonthlyCents"]),
        status: value["status"],
        ...(Array.isArray(value["desiredSkills"]) ? { desiredSkills: value["desiredSkills"] } : {}),
        ...(value["permissions"] !== undefined ? { permissions: recordOrNull(value["permissions"]) } : {}),
        ...(value["metadata"] !== undefined ? { metadata: recordOrNull(value["metadata"]) } : {}),
      };
    });
    const pipelines = pipelinesValue.map((value) => {
      if (!isRecord(value) || typeof value["key"] !== "string" || typeof value["enforceTransitions"] !== "boolean" ||
        (value["archivedAt"] !== null && typeof value["archivedAt"] !== "string")) {
        throw new GovernanceError("governance_metadata_invalid");
      }
      return { key: value["key"], enforceTransitions: value["enforceTransitions"], archivedAt: value["archivedAt"] };
    });
    return {
      company: {
        id: companyValue["id"],
        name: companyValue["name"],
        ...(typeof companyValue["status"] === "string" ? { status: companyValue["status"] } : {}),
      },
      agents,
      pipelines,
    };
  }
}

function positiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new GovernanceError("governance_metadata_invalid");
  }
  return value;
}

function timestamp(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || value.length > 64 || !Number.isFinite(Date.parse(value))) {
    throw new GovernanceError("governance_metadata_invalid");
  }
  return value;
}

export class GitHubReadOnlyReader implements GitHubGovernanceReader {
  readonly #client: ReadOnlyJsonClient;

  constructor(credential: SecretValue, fetchImplementation: FetchImplementation = fetch, apiBase = "https://api.github.com") {
    if (apiBase !== "https://api.github.com" && !/^https:\/\/github\.example\.test$/u.test(apiBase)) {
      throw new GovernanceError("governance_identity_unavailable");
    }
    this.#client = new ReadOnlyJsonClient(apiBase, credential, fetchImplementation, true);
  }

  async listRuns(owner: ScopeKey, repository: string, from: string, to: string): Promise<readonly GitHubWorkflowRun[]> {
    const runs: GitHubWorkflowRun[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const query = new URLSearchParams({
        created: `${from}..${to}`,
        status: "completed",
        per_page: "100",
        page: String(page),
      });
      const value = await this.#client.get(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/actions/runs?${query.toString()}`,
      );
      if (!isRecord(value) || !Number.isSafeInteger(value["total_count"]) || Number(value["total_count"]) > 1_000 ||
        !Array.isArray(value["workflow_runs"])) {
        throw new GovernanceError("governance_metadata_invalid");
      }
      const pageRuns = value["workflow_runs"];
      for (const run of pageRuns) {
        if (!isRecord(run) || typeof run["name"] !== "string" || typeof run["event"] !== "string" ||
          typeof run["status"] !== "string" || (run["conclusion"] !== null && typeof run["conclusion"] !== "string") ||
          !Array.isArray(run["pull_requests"])) {
          throw new GovernanceError("governance_metadata_invalid");
        }
        const baseRefs = run["pull_requests"].map((pullRequest) => {
          if (!isRecord(pullRequest) || !isRecord(pullRequest["base"]) || typeof pullRequest["base"]["ref"] !== "string") {
            throw new GovernanceError("governance_metadata_invalid");
          }
          return pullRequest["base"]["ref"];
        });
        runs.push({
          id: positiveInteger(run["id"]),
          name: run["name"],
          event: run["event"],
          status: run["status"],
          conclusion: run["conclusion"],
          runAttempt: positiveInteger(run["run_attempt"]),
          createdAt: timestamp(run["created_at"]) as string,
          runStartedAt: timestamp(run["run_started_at"]) as string,
          updatedAt: timestamp(run["updated_at"]) as string,
          baseRefs,
        });
      }
      if (pageRuns.length < 100) return runs;
    }
    throw new GovernanceError("governance_metadata_invalid");
  }

  async listJobs(owner: ScopeKey, repository: string, runId: number, attempt: number): Promise<readonly GitHubWorkflowJob[]> {
    const jobs: GitHubWorkflowJob[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const query = new URLSearchParams({ per_page: "100", page: String(page) });
      const value = await this.#client.get(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/actions/runs/${runId}/attempts/${attempt}/jobs?${query.toString()}`,
      );
      if (!isRecord(value) || !Number.isSafeInteger(value["total_count"]) || Number(value["total_count"]) > 1_000 ||
        !Array.isArray(value["jobs"])) {
        throw new GovernanceError("governance_metadata_invalid");
      }
      const pageJobs = value["jobs"];
      for (const job of pageJobs) {
        if (!isRecord(job) || typeof job["status"] !== "string" ||
          (job["conclusion"] !== null && typeof job["conclusion"] !== "string")) {
          throw new GovernanceError("governance_metadata_invalid");
        }
        jobs.push({
          status: job["status"],
          conclusion: job["conclusion"],
          startedAt: timestamp(job["started_at"], true),
          completedAt: timestamp(job["completed_at"], true),
        });
      }
      if (pageJobs.length < 100) return jobs;
    }
    throw new GovernanceError("governance_metadata_invalid");
  }
}

function environmentPrefix(key: ScopeKey): string {
  return `FLAMA_GOVERNANCE_${key.toUpperCase()}`;
}

export function createGovernanceReaders(
  environment: Environment,
  fetchImplementation: FetchImplementation = fetch,
): GovernanceReaders {
  const readers = new Map<ScopeKey, { readonly paperclip: PaperclipGovernanceReader; readonly github: GitHubGovernanceReader }>();
  const credentialValues: string[] = [];
  for (const key of scopeKeys) {
    const prefix = environmentPrefix(key);
    const paperclipBase = environment[`${prefix}_PAPERCLIP_API_URL`];
    const paperclipCredential = environment[`${prefix}_PAPERCLIP_API_KEY`];
    const githubCredential = environment[`${prefix}_GITHUB_TOKEN`];
    if (!validCredential(paperclipCredential) || !validGitHubCredential(githubCredential)) {
      throw new GovernanceError("governance_identity_unavailable");
    }
    credentialValues.push(paperclipCredential, githubCredential);
    readers.set(key, {
      paperclip: new PaperclipReadOnlyReader(safePaperclipBase(paperclipBase), new SecretValue(paperclipCredential), fetchImplementation),
      github: new GitHubReadOnlyReader(new SecretValue(githubCredential), fetchImplementation),
    });
  }
  if (new Set(credentialValues).size !== credentialValues.length) {
    throw new GovernanceError("governance_identity_unavailable");
  }
  return {
    paperclip(key) {
      const reader = readers.get(key)?.paperclip;
      if (reader === undefined) throw new GovernanceError("governance_identity_unavailable");
      return reader;
    },
    github(key) {
      const reader = readers.get(key)?.github;
      if (reader === undefined) throw new GovernanceError("governance_identity_unavailable");
      return reader;
    },
  };
}
