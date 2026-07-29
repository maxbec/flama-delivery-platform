import { describe, expect, it, vi } from "vitest";
import { SecretValue } from "../../bridge/src/config.js";
import { GovernanceError } from "./governance.js";
import { createGovernanceReaders, GitHubReadOnlyReader, PaperclipReadOnlyReader } from "./readers.js";

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

describe("read-only governance readers", () => {
  it("uses only documented GET endpoints and projects bounded metadata", async () => {
    const requests: Array<{ url: string; method: string | undefined; authorization: string | null }> = [];
    const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      requests.push({ url, method: init?.method, authorization: headers.get("authorization") });
      if (url.endsWith("/agents")) return json([{
        id: "agent",
        companyId: "11111111-1111-4111-8111-111111111111",
        name: "maxbec-delivery-controller",
        role: "devops",
        adapterType: "process",
        budgetMonthlyCents: 0,
        status: "paused",
      }]);
      if (url.endsWith("/pipelines")) return json([{
        key: "flama-project-bootstrap-v1",
        enforceTransitions: true,
        archivedAt: null,
      }]);
      return json({ id: "11111111-1111-4111-8111-111111111111", name: "Private", status: "active" });
    });
    const reader = new PaperclipReadOnlyReader(
      "http://127.0.0.1:3100",
      new SecretValue("test-only-paperclip-reader-key"),
      fetcher,
    );
    const result = await reader.readSnapshot("11111111-1111-4111-8111-111111111111");
    expect(result.company.name).toBe("Private");
    expect(requests).toHaveLength(3);
    expect(requests.every(({ method }) => method === "GET")).toBe(true);
    expect(requests.every(({ authorization }) => authorization === "Bearer test-only-paperclip-reader-key")).toBe(true);
  });

  it("reads GitHub runs and exact-attempt jobs through GET-only pagination", async () => {
    const urls: string[] = [];
    const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      const url = String(input);
      urls.push(url);
      if (url.includes("/jobs?")) return json({ total_count: 1, jobs: [{
        status: "completed",
        conclusion: "success",
        started_at: "2026-07-02T10:00:00.000Z",
        completed_at: "2026-07-02T10:01:00.000Z",
      }] });
      return json({ total_count: 1, workflow_runs: [{
        id: 99,
        name: "Final Gate",
        event: "pull_request",
        status: "completed",
        conclusion: "success",
        run_attempt: 2,
        created_at: "2026-07-02T09:59:50.000Z",
        run_started_at: "2026-07-02T10:00:00.000Z",
        updated_at: "2026-07-02T10:01:10.000Z",
        pull_requests: [{ base: { ref: "main" } }],
      }] });
    });
    const reader = new GitHubReadOnlyReader(
      new SecretValue("test-only-github-reader-key"),
      fetcher,
      "https://github.example.test",
    );
    const runs = await reader.listRuns("maxbec", "example", "2026-07-01T00:00:00.000Z", "2026-07-08T00:00:00.000Z");
    const jobs = await reader.listJobs("maxbec", "example", 99, 2);
    expect(runs[0]).toMatchObject({ runAttempt: 2, baseRefs: ["main"] });
    expect(jobs).toHaveLength(1);
    expect(urls[1]).toContain("/runs/99/attempts/2/jobs?");
  });

  it("rejects shared credentials across company boundaries", () => {
    const shared = "test-only-shared-reader-key";
    const environment: Record<string, string> = {};
    for (const key of ["MAXBEC", "NAVIGAITE", "EDILIO"] as const) {
      environment[`FLAMA_GOVERNANCE_${key}_PAPERCLIP_API_URL`] = "http://127.0.0.1:3100";
      environment[`FLAMA_GOVERNANCE_${key}_PAPERCLIP_API_KEY`] = shared;
      environment[`FLAMA_GOVERNANCE_${key}_GITHUB_TOKEN`] = `test-only-${key.toLowerCase()}-github-token`;
    }
    expect(() => createGovernanceReaders(environment)).toThrowError(
      expect.objectContaining<Partial<GovernanceError>>({ code: "governance_identity_unavailable" }),
    );
  });

  it("rejects non-installation GitHub token forms", () => {
    const environment: Record<string, string> = {};
    for (const key of ["MAXBEC", "NAVIGAITE", "EDILIO"] as const) {
      environment[`FLAMA_GOVERNANCE_${key}_PAPERCLIP_API_URL`] = "http://127.0.0.1:3100";
      environment[`FLAMA_GOVERNANCE_${key}_PAPERCLIP_API_KEY`] = `test-only-${key.toLowerCase()}-paperclip-key`;
      environment[`FLAMA_GOVERNANCE_${key}_GITHUB_TOKEN`] = `personal-access-form-${key.toLowerCase()}-value`;
    }
    expect(() => createGovernanceReaders(environment)).toThrowError(
      expect.objectContaining<Partial<GovernanceError>>({ code: "governance_identity_unavailable" }),
    );
  });

  it("suppresses non-JSON response bodies", async () => {
    const sensitive = "should-not-escape-reader";
    const reader = new GitHubReadOnlyReader(
      new SecretValue("test-only-github-reader-key"),
      async () => new Response(sensitive, { status: 403, headers: { "content-type": "text/plain" } }),
      "https://github.example.test",
    );
    let observed: unknown;
    try {
      await reader.listRuns("maxbec", "example", "2026-07-01T00:00:00.000Z", "2026-07-08T00:00:00.000Z");
    } catch (error) {
      observed = error;
    }
    expect(String(observed)).not.toContain(sensitive);
    expect(observed).toMatchObject({ code: "governance_read_failed" });
  });
});
