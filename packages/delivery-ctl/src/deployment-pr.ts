export type ReviewState = "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED" | "COMMENTED";

export interface DeploymentPullRequestInput {
  readonly schemaVersion: 1;
  readonly requiredReviewer: "maxbec";
  readonly requestedHeadSha: string;
  readonly requestedMergeSha: string;
  readonly pullRequest: {
    readonly merged: boolean;
    readonly headSha: string;
    readonly mergeSha: string;
    readonly baseBranch: string;
    readonly changedFiles: readonly string[];
  };
  readonly reviews: readonly {
    readonly reviewer: string;
    readonly state: ReviewState;
    readonly commitSha: string;
    readonly submittedAt: string;
  }[];
}

export interface DeploymentPullRequestFinding {
  readonly code: string;
  readonly location: string;
}

export interface DeploymentPullRequestResult {
  readonly schemaVersion: 1;
  readonly status: "passed" | "failed";
  readonly findingCount: number;
  readonly findings: readonly DeploymentPullRequestFinding[];
}

export function auditDeploymentPullRequest(
  input: DeploymentPullRequestInput,
): DeploymentPullRequestResult {
  const findings: DeploymentPullRequestFinding[] = [];
  const add = (code: string, location: string): void => {
    findings.push({ code, location });
  };

  if (!input.pullRequest.merged) add("deployment_pr_not_merged", "pullRequest.merged");
  if (input.pullRequest.baseBranch !== "main") add("deployment_base_not_main", "pullRequest.baseBranch");
  if (input.pullRequest.headSha !== input.requestedHeadSha) {
    add("deployment_head_sha_mismatch", "pullRequest.headSha");
  }
  if (input.pullRequest.mergeSha !== input.requestedMergeSha) {
    add("deployment_merge_sha_mismatch", "pullRequest.mergeSha");
  }
  if (
    input.pullRequest.changedFiles.length !== 1 ||
    input.pullRequest.changedFiles[0] !== ".deploy/production.yaml"
  ) {
    add("deployment_files_out_of_scope", "pullRequest.changedFiles");
  }

  const latestReview = input.reviews
    .filter(({ reviewer }) => reviewer === input.requiredReviewer)
    .sort((left, right) => left.submittedAt.localeCompare(right.submittedAt))
    .at(-1);
  if (latestReview === undefined || latestReview.state !== "APPROVED") {
    add("owner_approval_missing", "reviews");
  } else if (latestReview.commitSha !== input.pullRequest.headSha) {
    add("approval_not_bound_to_head", "reviews");
  }

  findings.sort((left, right) =>
    left.code === right.code
      ? left.location.localeCompare(right.location)
      : left.code.localeCompare(right.code),
  );
  return {
    schemaVersion: 1,
    status: findings.length === 0 ? "passed" : "failed",
    findingCount: findings.length,
    findings,
  };
}
