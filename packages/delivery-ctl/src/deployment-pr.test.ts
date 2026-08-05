import { describe, expect, it } from "vitest";
import { auditDeploymentPullRequest, type DeploymentPullRequestInput } from "./deployment-pr.js";

const headSha = "a".repeat(40);
const mergeSha = "b".repeat(40);

const validInput: DeploymentPullRequestInput = {
  schemaVersion: 1,
  requiredReviewer: "maxbec",
  requestedHeadSha: headSha,
  requestedMergeSha: mergeSha,
  pullRequest: {
    merged: true,
    headSha,
    mergeSha,
    baseBranch: "main",
    changedFiles: [".deploy/production.yaml"],
  },
  reviews: [
    {
      reviewer: "maxbec",
      state: "APPROVED",
      commitSha: headSha,
      submittedAt: "2026-07-28T09:00:00.000Z",
    },
  ],
};

describe("deployment pull request audit", () => {
  it("accepts Max's approval bound to the exact manifest-only head SHA", () => {
    expect(auditDeploymentPullRequest(validInput)).toEqual({
      schemaVersion: 1,
      status: "passed",
      findingCount: 0,
      findings: [],
    });
  });

  it("rejects stale approval and extra changed files without echoing names", () => {
    const result = auditDeploymentPullRequest({
      ...validInput,
      pullRequest: {
        ...validInput.pullRequest,
        changedFiles: [".deploy/production.yaml", "src/backdoor.ts"],
      },
      reviews: [
        {
          reviewer: "maxbec",
          state: "APPROVED",
          commitSha: "c".repeat(40),
          submittedAt: "2026-07-28T09:00:00.000Z",
        },
      ],
    });

    expect(result).toEqual({
      schemaVersion: 1,
      status: "failed",
      findingCount: 2,
      findings: [
        { code: "approval_not_bound_to_head", location: "reviews" },
        { code: "deployment_files_out_of_scope", location: "pullRequest.changedFiles" },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("backdoor");
    expect(JSON.stringify(result)).not.toContain("maxbec");
  });

  it("uses the latest review state from the required reviewer", () => {
    const result = auditDeploymentPullRequest({
      ...validInput,
      reviews: [
        ...validInput.reviews,
        {
          reviewer: "maxbec",
          state: "DISMISSED",
          commitSha: headSha,
          submittedAt: "2026-07-28T09:01:00.000Z",
        },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.findings).toContainEqual({ code: "owner_approval_missing", location: "reviews" });
  });
});
