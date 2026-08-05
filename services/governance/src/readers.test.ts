import { describe, expect, it, vi } from "vitest";
import { SecretValue } from "../../bridge/src/config.js";
import { GovernanceError } from "./governance.js";
import { createGovernanceReaders, GitHubReadOnlyReader } from "./readers.js";

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

describe("read-only governance readers", () => {
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

  it("rejects shared GitHub credentials across owner boundaries", () => {
    const shared = "test-only-shared-reader-key";
    const environment: Record<string, string> = {};
    for (const key of ["MAXBEC", "NAVIGAITE", "EDILIO"] as const) {
      environment[`FLAMA_GOVERNANCE_${key}_GITHUB_TOKEN`] = shared;
    }
    expect(() => createGovernanceReaders(environment)).toThrowError(
      expect.objectContaining<Partial<GovernanceError>>({ code: "governance_identity_unavailable" }),
    );
  });

  it("rejects non-installation GitHub token forms", () => {
    const environment: Record<string, string> = {};
    for (const key of ["MAXBEC", "NAVIGAITE", "EDILIO"] as const) {
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

describe("cache marker step reading", () => {
  function reader(jobPayload: unknown): GitHubReadOnlyReader {
    const fetcher = vi.fn(async (input: string | URL) => {
      if (String(input).includes("/jobs?")) return json({ total_count: 1, jobs: [jobPayload] });
      return json({ total_count: 0, workflow_runs: [] });
    });
    return new GitHubReadOnlyReader(
      new SecretValue("test-only-github-reader-key"),
      fetcher,
      "https://github.example.test",
    );
  }

  const completedJob = {
    status: "completed",
    conclusion: "success",
    started_at: "2026-07-02T10:00:00.000Z",
    completed_at: "2026-07-02T10:01:00.000Z",
  };

  it("carries step names and conclusions so the cache marker is observable", async () => {
    const jobs = await reader({
      ...completedJob,
      steps: [
        { name: "Install locked dependencies", status: "completed", conclusion: "success" },
        { name: "Record dependency cache hit", status: "completed", conclusion: "skipped" },
      ],
    }).listJobs("maxbec", "example", 99, 2);

    expect(jobs[0]?.steps).toEqual([
      { name: "Install locked dependencies", conclusion: "success" },
      { name: "Record dependency cache hit", conclusion: "skipped" },
    ]);
  });

  it("reports no steps when the jobs payload omits them", async () => {
    const jobs = await reader(completedJob).listJobs("maxbec", "example", 99, 2);

    expect(jobs[0]?.steps).toBeUndefined();
  });

  it("rejects a malformed step entry rather than guessing a cache outcome", async () => {
    await expect(
      reader({ ...completedJob, steps: [{ name: 42, conclusion: "success" }] })
        .listJobs("maxbec", "example", 99, 2),
    ).rejects.toBeInstanceOf(GovernanceError);
  });
});
