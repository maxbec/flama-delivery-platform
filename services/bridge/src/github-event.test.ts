import { describe, expect, it } from "vitest";
import { sanitizeGitHubWebhook } from "./github-event.js";

const sha = "a".repeat(40);

describe("GitHub webhook minimization", () => {
  it("retains only lifecycle evidence from pull requests", () => {
    const result = sanitizeGitHubWebhook("pull_request", {
      action: "closed",
      repository: { id: 101, full_name: "maxbec/api", private: true },
      pull_request: {
        number: 7,
        state: "closed",
        merged: true,
        head: { sha, ref: "feature/verified-change" },
        base: { ref: "main" },
        merge_commit_sha: sha,
        html_url: "https://github.com/maxbec/api/pull/7",
        body: "sensitive-value-that-must-not-be-persisted",
        user: { email: "private@example.invalid" },
      },
      sender: { email: "private@example.invalid" },
    });

    expect(result).toEqual({
      status: "accepted",
      event: {
        schemaVersion: 1,
        eventName: "pull_request",
        action: "closed",
        repository: "maxbec/api",
        repositoryId: 101,
        pullRequest: {
          number: 7,
          state: "closed",
          merged: true,
          headSha: sha,
          headRef: "feature/verified-change",
          baseRef: "main",
          mergeSha: sha,
          url: "https://github.com/maxbec/api/pull/7",
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("sensitive-value");
    expect(JSON.stringify(result)).not.toContain("private@example.invalid");
  });

  it("captures exact-SHA review approval evidence without review text", () => {
    const result = sanitizeGitHubWebhook("pull_request_review", {
      action: "submitted",
      repository: { id: 102, full_name: "navigaite/app" },
      pull_request: {
        number: 9,
        head: { sha, ref: "deploy/v1.0.0" },
        base: { ref: "main" },
      },
      review: {
        id: 55,
        state: "approved",
        commit_id: sha,
        submitted_at: "2026-07-28T20:00:00Z",
        html_url: "https://github.com/navigaite/app/pull/9#pullrequestreview-55",
        user: { login: "maxbec" },
        body: "do-not-retain-review-text",
      },
    });

    expect(result.status).toBe("accepted");
    expect(JSON.stringify(result)).not.toContain("do-not-retain-review-text");
    if (result.status === "accepted") {
      expect(result.event).toMatchObject({
        eventName: "pull_request_review",
        pullRequest: { headRef: "deploy/v1.0.0", baseRef: "main" },
        review: { id: 55, state: "approved", commitSha: sha, reviewer: "maxbec" },
      });
    }
  });

  it("retains safe legacy base branches during phased migration", () => {
    const result = sanitizeGitHubWebhook("pull_request", {
      action: "opened",
      repository: { id: 104, full_name: "edilio-app/legacy-plugin" },
      pull_request: {
        number: 3,
        state: "open",
        merged: false,
        head: { sha, ref: "feature/legacy-fix" },
        base: { ref: "develop" },
        merge_commit_sha: null,
        html_url: "https://github.com/edilio-app/legacy-plugin/pull/3",
      },
    });

    expect(result).toMatchObject({
      status: "accepted",
      event: { pullRequest: { baseRef: "develop" } },
    });
  });

  it("ignores unneeded event types and actions", () => {
    expect(sanitizeGitHubWebhook("issues", { action: "opened" })).toEqual({ status: "ignored" });
    expect(
      sanitizeGitHubWebhook("pull_request", {
        action: "labeled",
        repository: { id: 101, full_name: "maxbec/api" },
      }),
    ).toEqual({ status: "ignored" });
  });

  it("rejects malformed evidence for a supported event", () => {
    expect(
      sanitizeGitHubWebhook("release", {
        action: "published",
        repository: { id: 103, full_name: "edilio-app/plugin" },
        release: { id: 4, tag_name: "v1.0.0", target_commitish: "main" },
      }),
    ).toEqual({ status: "invalid" });
  });

  it.each([
    [
      "workflow_run",
      {
        action: "completed",
        repository: { id: 201, full_name: "maxbec/api" },
        workflow_run: { id: 1, name: "Final Gate", status: "completed", conclusion: "success", head_sha: sha, html_url: "https://github.com/maxbec/api/actions/runs/1" },
      },
      "workflow_run",
    ],
    [
      "check_run",
      {
        action: "completed",
        repository: { id: 202, full_name: "navigaite/app" },
        check_run: { id: 2, name: "Paperclip Preflight", app: { slug: "paperclip-preflight" }, status: "completed", conclusion: "failure", head_sha: sha, html_url: "https://github.com/navigaite/app/runs/2" },
      },
      "check_run",
    ],
    [
      "release",
      {
        action: "published",
        repository: { id: 203, full_name: "edilio-app/plugin" },
        release: { id: 3, tag_name: "v1.0.0", target_commitish: "main", draft: false, prerelease: false, html_url: "https://github.com/edilio-app/plugin/releases/tag/v1.0.0" },
      },
      "release",
    ],
    [
      "deployment_status",
      {
        action: "created",
        repository: { id: 204, full_name: "maxbec/service" },
        deployment: { id: 4, ref: "main", sha },
        deployment_status: { id: 5, state: "success", environment: "production", environment_url: "https://service.example.invalid", log_url: null },
      },
      "deployment_status",
    ],
    [
      "push",
      {
        repository: { id: 205, full_name: "navigaite/tool" },
        ref: "refs/heads/dev",
        before: sha,
        after: "b".repeat(40),
        created: false,
        deleted: false,
        forced: false,
      },
      "push",
    ],
  ] as const)("minimizes the %s event", (eventName, payload, expectedEventName) => {
    const result = sanitizeGitHubWebhook(eventName, { ...payload, sender: { email: "private@example.invalid" } });

    expect(result).toMatchObject({ status: "accepted", event: { eventName: expectedEventName } });
    expect(JSON.stringify(result)).not.toContain("private@example.invalid");
  });
});
