type JsonRecord = Readonly<Record<string, unknown>>;

const supportedOwners = ["maxbec", "navigaite", "edilio"] as const;
export type GitHubOwner = (typeof supportedOwners)[number];

type SafeGitHubEvent = JsonRecord & {
  readonly schemaVersion: 1;
  readonly eventName: string;
  readonly action: string;
  readonly repository: string;
  readonly repositoryId: number;
};

export type GitHubWebhookSanitization =
  | { readonly status: "accepted"; readonly event: SafeGitHubEvent }
  | { readonly status: "ignored" }
  | { readonly status: "invalid" };

function record(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function stringValue(value: unknown, pattern: RegExp, maximumLength = 2_048): string | undefined {
  return typeof value === "string" && value.length <= maximumLength && pattern.test(value)
    ? value
    : undefined;
}

function integerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function shaValue(value: unknown): string | undefined {
  return stringValue(value, /^[0-9a-f]{40}$/u, 40);
}

function branchValue(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 255) return undefined;
  if (
    /[\u0000-\u0020\u007f~^:?*\[\\]/u.test(value) || value === "@" || value.includes("..") ||
    value.includes("//") || value.includes("@{") || value.startsWith(".") || value.endsWith(".") ||
    value.endsWith("/") || value.endsWith(".lock")
  ) return undefined;
  return value;
}

function nullableShaValue(value: unknown): string | null | undefined {
  return value === null ? null : shaValue(value);
}

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2_048) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.username.length === 0 && parsed.password.length === 0
      ? parsed.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function optionalSafeUrl(value: unknown): string | null | undefined {
  return value === null || value === "" ? null : safeUrl(value);
}

function dateTimeValue(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 64) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? value : undefined;
}

function optionalDateTimeValue(value: unknown): string | null | undefined {
  return value === null ? null : dateTimeValue(value);
}

function repositoryEvidence(payload: JsonRecord):
  | { readonly repository: string; readonly repositoryId: number }
  | undefined {
  const repository = record(payload["repository"]);
  if (repository === undefined) return undefined;
  const fullName = stringValue(
    repository["full_name"],
    /^(?:maxbec|navigaite|edilio)\/[A-Za-z0-9._-]+$/u,
    256,
  );
  const repositoryId = integerValue(repository["id"]);
  return fullName === undefined || repositoryId === undefined
    ? undefined
    : { repository: fullName, repositoryId };
}

function inValues<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): value is Values[number] {
  return typeof value === "string" && values.includes(value as Values[number]);
}

function onlyKeys(value: JsonRecord, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key)) && Object.keys(value).length === keys.length;
}

function validBaseMinimizedEvent(
  value: JsonRecord,
  expectedEventName: string,
  expectedRepository: string,
  detailKey: string,
): boolean {
  return onlyKeys(value, ["schemaVersion", "eventName", "action", "repository", "repositoryId", detailKey]) &&
    value["schemaVersion"] === 1 && value["eventName"] === expectedEventName &&
    value["repository"] === expectedRepository && integerValue(value["repositoryId"]) !== undefined &&
    typeof value["action"] === "string";
}

function sanitizePullRequest(payload: JsonRecord, action: string): SafeGitHubEvent | undefined {
  const repository = repositoryEvidence(payload);
  const pullRequest = record(payload["pull_request"]);
  const head = record(pullRequest?.["head"]);
  const base = record(pullRequest?.["base"]);
  if (repository === undefined || pullRequest === undefined || head === undefined || base === undefined) {
    return undefined;
  }
  const number = integerValue(pullRequest["number"]);
  const state = inValues(pullRequest["state"], ["open", "closed"] as const)
    ? pullRequest["state"]
    : undefined;
  const merged = booleanValue(pullRequest["merged"]);
  const headSha = shaValue(head["sha"]);
  const baseRef = branchValue(base["ref"]);
  const mergeSha = nullableShaValue(pullRequest["merge_commit_sha"]);
  const url = safeUrl(pullRequest["html_url"]);
  if (
    number === undefined || state === undefined || merged === undefined || headSha === undefined ||
    baseRef === undefined || mergeSha === undefined || url === undefined
  ) return undefined;
  return {
    schemaVersion: 1,
    eventName: "pull_request",
    action,
    ...repository,
    pullRequest: { number, state, merged, headSha, baseRef, mergeSha, url },
  };
}

function sanitizeReview(payload: JsonRecord, action: string): SafeGitHubEvent | undefined {
  const repository = repositoryEvidence(payload);
  const pullRequest = record(payload["pull_request"]);
  const head = record(pullRequest?.["head"]);
  const review = record(payload["review"]);
  const user = record(review?.["user"]);
  if (
    repository === undefined || pullRequest === undefined || head === undefined ||
    review === undefined || user === undefined
  ) return undefined;
  const pullRequestNumber = integerValue(pullRequest["number"]);
  const headSha = shaValue(head["sha"]);
  const id = integerValue(review["id"]);
  const state = inValues(review["state"], ["approved", "changes_requested", "commented", "dismissed"] as const)
    ? review["state"]
    : undefined;
  const commitSha = shaValue(review["commit_id"]);
  const reviewer = stringValue(user["login"], /^[A-Za-z0-9-]{1,39}$/u, 39);
  const submittedAt = optionalDateTimeValue(review["submitted_at"]);
  const url = safeUrl(review["html_url"]);
  if (
    pullRequestNumber === undefined || headSha === undefined || id === undefined || state === undefined ||
    commitSha === undefined || reviewer === undefined || submittedAt === undefined || url === undefined
  ) return undefined;
  return {
    schemaVersion: 1,
    eventName: "pull_request_review",
    action,
    ...repository,
    pullRequest: { number: pullRequestNumber, headSha },
    review: { id, state, commitSha, reviewer, submittedAt, url },
  };
}

function sanitizeWorkflowRun(payload: JsonRecord, action: string): SafeGitHubEvent | undefined {
  const repository = repositoryEvidence(payload);
  const run = record(payload["workflow_run"]);
  if (repository === undefined || run === undefined) return undefined;
  const id = integerValue(run["id"]);
  const status = inValues(run["status"], ["requested", "in_progress", "completed", "queued", "waiting", "pending"] as const)
    ? run["status"]
    : undefined;
  const conclusion = run["conclusion"] === null
    ? null
    : inValues(run["conclusion"], ["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "stale"] as const)
      ? run["conclusion"]
      : undefined;
  const headSha = shaValue(run["head_sha"]);
  const url = safeUrl(run["html_url"]);
  if (id === undefined || status === undefined || conclusion === undefined || headSha === undefined || url === undefined) {
    return undefined;
  }
  return { schemaVersion: 1, eventName: "workflow_run", action, ...repository, workflowRun: { id, status, conclusion, headSha, url } };
}

function sanitizeCheckRun(payload: JsonRecord, action: string): SafeGitHubEvent | undefined {
  const repository = repositoryEvidence(payload);
  const run = record(payload["check_run"]);
  if (repository === undefined || run === undefined) return undefined;
  const id = integerValue(run["id"]);
  const status = inValues(run["status"], ["queued", "in_progress", "completed", "waiting", "pending"] as const)
    ? run["status"]
    : undefined;
  const conclusion = run["conclusion"] === null
    ? null
    : inValues(run["conclusion"], ["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "stale"] as const)
      ? run["conclusion"]
      : undefined;
  const headSha = shaValue(run["head_sha"]);
  const url = safeUrl(run["html_url"]);
  if (id === undefined || status === undefined || conclusion === undefined || headSha === undefined || url === undefined) {
    return undefined;
  }
  return { schemaVersion: 1, eventName: "check_run", action, ...repository, checkRun: { id, status, conclusion, headSha, url } };
}

function sanitizeRelease(payload: JsonRecord, action: string): SafeGitHubEvent | undefined {
  const repository = repositoryEvidence(payload);
  const release = record(payload["release"]);
  if (repository === undefined || release === undefined) return undefined;
  const id = integerValue(release["id"]);
  const tagName = stringValue(release["tag_name"], /^[^\u0000-\u001f\u007f\s]+$/u, 255);
  const targetCommitish = stringValue(release["target_commitish"], /^[^\u0000-\u001f\u007f\s]+$/u, 255);
  const draft = booleanValue(release["draft"]);
  const prerelease = booleanValue(release["prerelease"]);
  const url = safeUrl(release["html_url"]);
  if (
    id === undefined || tagName === undefined || targetCommitish === undefined || draft === undefined ||
    prerelease === undefined || url === undefined
  ) return undefined;
  return {
    schemaVersion: 1,
    eventName: "release",
    action,
    ...repository,
    release: { id, tagName, targetCommitish, draft, prerelease, url },
  };
}

function sanitizeDeploymentStatus(payload: JsonRecord, action: string): SafeGitHubEvent | undefined {
  const repository = repositoryEvidence(payload);
  const statusRecord = record(payload["deployment_status"]);
  const deployment = record(payload["deployment"]);
  if (repository === undefined || statusRecord === undefined || deployment === undefined) return undefined;
  const statusId = integerValue(statusRecord["id"]);
  const state = inValues(statusRecord["state"], ["error", "failure", "inactive", "in_progress", "queued", "pending", "success"] as const)
    ? statusRecord["state"]
    : undefined;
  const environment = stringValue(statusRecord["environment"], /^[^\u0000-\u001f\u007f]+$/u, 255);
  const environmentUrl = optionalSafeUrl(statusRecord["environment_url"]);
  const logUrl = optionalSafeUrl(statusRecord["log_url"]);
  const deploymentId = integerValue(deployment["id"]);
  const ref = stringValue(deployment["ref"], /^[^\u0000-\u001f\u007f\s]+$/u, 255);
  const sha = shaValue(deployment["sha"]);
  if (
    statusId === undefined || state === undefined || environment === undefined || environmentUrl === undefined ||
    logUrl === undefined || deploymentId === undefined || ref === undefined || sha === undefined
  ) return undefined;
  return {
    schemaVersion: 1,
    eventName: "deployment_status",
    action,
    ...repository,
    deployment: { id: deploymentId, ref, sha },
    deploymentStatus: { id: statusId, state, environment, environmentUrl, logUrl },
  };
}

function sanitizePush(payload: JsonRecord): SafeGitHubEvent | undefined {
  const repository = repositoryEvidence(payload);
  if (repository === undefined) return undefined;
  const ref = stringValue(payload["ref"], /^refs\/(?:heads|tags)\/[^\u0000-\u001f\u007f]+$/u, 512);
  const before = shaValue(payload["before"]);
  const after = shaValue(payload["after"]);
  const created = booleanValue(payload["created"]);
  const deleted = booleanValue(payload["deleted"]);
  const forced = booleanValue(payload["forced"]);
  if (ref === undefined || before === undefined || after === undefined || created === undefined || deleted === undefined || forced === undefined) {
    return undefined;
  }
  return { schemaVersion: 1, eventName: "push", action: "updated", ...repository, push: { ref, before, after, created, deleted, forced } };
}

export function sanitizeGitHubWebhook(eventName: string, value: unknown): GitHubWebhookSanitization {
  const payload = record(value);
  if (payload === undefined) return { status: "invalid" };
  const action = payload["action"];
  let event: SafeGitHubEvent | undefined;

  switch (eventName) {
    case "pull_request":
      if (!inValues(action, ["opened", "synchronize", "reopened", "closed", "ready_for_review", "converted_to_draft"] as const)) return { status: "ignored" };
      event = sanitizePullRequest(payload, action);
      break;
    case "pull_request_review":
      if (!inValues(action, ["submitted", "dismissed"] as const)) return { status: "ignored" };
      event = sanitizeReview(payload, action);
      break;
    case "workflow_run":
      if (!inValues(action, ["requested", "in_progress", "completed"] as const)) return { status: "ignored" };
      event = sanitizeWorkflowRun(payload, action);
      break;
    case "check_run":
      if (!inValues(action, ["created", "rerequested", "completed"] as const)) return { status: "ignored" };
      event = sanitizeCheckRun(payload, action);
      break;
    case "release":
      if (!inValues(action, ["published", "released"] as const)) return { status: "ignored" };
      event = sanitizeRelease(payload, action);
      break;
    case "deployment_status":
      if (action !== "created") return { status: "ignored" };
      event = sanitizeDeploymentStatus(payload, action);
      break;
    case "push":
      event = sanitizePush(payload);
      break;
    default:
      return { status: "ignored" };
  }
  return event === undefined ? { status: "invalid" } : { status: "accepted", event };
}

export function githubOwner(repository: string): GitHubOwner | undefined {
  const owner = repository.split("/", 1)[0];
  return supportedOwners.includes(owner as GitHubOwner) ? (owner as GitHubOwner) : undefined;
}

export function transitionKindForMinimizedEvent(
  value: Readonly<Record<string, unknown>>,
  expectedEventName: string,
  expectedRepository: string,
): string | undefined {
  const action = value["action"];
  switch (expectedEventName) {
    case "pull_request": {
      const pullRequest = record(value["pullRequest"]);
      if (
        !validBaseMinimizedEvent(value, expectedEventName, expectedRepository, "pullRequest") ||
        !inValues(action, ["opened", "synchronize", "reopened", "closed", "ready_for_review", "converted_to_draft"] as const) ||
        pullRequest === undefined ||
        !onlyKeys(pullRequest, ["number", "state", "merged", "headSha", "baseRef", "mergeSha", "url"]) ||
        integerValue(pullRequest["number"]) === undefined ||
        !inValues(pullRequest["state"], ["open", "closed"] as const) ||
        booleanValue(pullRequest["merged"]) === undefined || shaValue(pullRequest["headSha"]) === undefined ||
        branchValue(pullRequest["baseRef"]) === undefined ||
        nullableShaValue(pullRequest["mergeSha"]) === undefined || safeUrl(pullRequest["url"]) === undefined
      ) return undefined;
      return action === "closed" && pullRequest["merged"] === true ? "pull_request.merged" : `pull_request.${action}`;
    }
    case "pull_request_review": {
      if (
        !onlyKeys(value, ["schemaVersion", "eventName", "action", "repository", "repositoryId", "pullRequest", "review"]) ||
        value["schemaVersion"] !== 1 || value["eventName"] !== expectedEventName ||
        value["repository"] !== expectedRepository || integerValue(value["repositoryId"]) === undefined ||
        !inValues(action, ["submitted", "dismissed"] as const)
      ) return undefined;
      const pullRequest = record(value["pullRequest"]);
      const review = record(value["review"]);
      if (
        pullRequest === undefined || !onlyKeys(pullRequest, ["number", "headSha"]) ||
        integerValue(pullRequest["number"]) === undefined || shaValue(pullRequest["headSha"]) === undefined ||
        review === undefined ||
        !onlyKeys(review, ["id", "state", "commitSha", "reviewer", "submittedAt", "url"]) ||
        integerValue(review["id"]) === undefined ||
        !inValues(review["state"], ["approved", "changes_requested", "commented", "dismissed"] as const) ||
        shaValue(review["commitSha"]) === undefined ||
        stringValue(review["reviewer"], /^[A-Za-z0-9-]{1,39}$/u, 39) === undefined ||
        optionalDateTimeValue(review["submittedAt"]) === undefined || safeUrl(review["url"]) === undefined
      ) return undefined;
      const state = review?.["state"];
      return typeof state === "string" ? `pull_request_review.${action === "dismissed" ? "dismissed" : state}` : undefined;
    }
    case "workflow_run": {
      const run = record(value["workflowRun"]);
      if (
        !validBaseMinimizedEvent(value, expectedEventName, expectedRepository, "workflowRun") ||
        !inValues(action, ["requested", "in_progress", "completed"] as const) || run === undefined ||
        !onlyKeys(run, ["id", "status", "conclusion", "headSha", "url"]) ||
        integerValue(run["id"]) === undefined ||
        !inValues(run["status"], ["requested", "in_progress", "completed", "queued", "waiting", "pending"] as const) ||
        !(run["conclusion"] === null || inValues(run["conclusion"], ["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "stale"] as const)) ||
        shaValue(run["headSha"]) === undefined || safeUrl(run["url"]) === undefined
      ) return undefined;
      return `workflow_run.${action}`;
    }
    case "check_run": {
      const run = record(value["checkRun"]);
      if (
        !validBaseMinimizedEvent(value, expectedEventName, expectedRepository, "checkRun") ||
        !inValues(action, ["created", "rerequested", "completed"] as const) || run === undefined ||
        !onlyKeys(run, ["id", "status", "conclusion", "headSha", "url"]) ||
        integerValue(run["id"]) === undefined ||
        !inValues(run["status"], ["queued", "in_progress", "completed", "waiting", "pending"] as const) ||
        !(run["conclusion"] === null || inValues(run["conclusion"], ["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "stale"] as const)) ||
        shaValue(run["headSha"]) === undefined || safeUrl(run["url"]) === undefined
      ) return undefined;
      return `check_run.${action}`;
    }
    case "release": {
      const release = record(value["release"]);
      if (
        !validBaseMinimizedEvent(value, expectedEventName, expectedRepository, "release") ||
        !inValues(action, ["published", "released"] as const) || release === undefined ||
        !onlyKeys(release, ["id", "tagName", "targetCommitish", "draft", "prerelease", "url"]) ||
        integerValue(release["id"]) === undefined ||
        stringValue(release["tagName"], /^[^\u0000-\u001f\u007f\s]+$/u, 255) === undefined ||
        stringValue(release["targetCommitish"], /^[^\u0000-\u001f\u007f\s]+$/u, 255) === undefined ||
        booleanValue(release["draft"]) === undefined || booleanValue(release["prerelease"]) === undefined ||
        safeUrl(release["url"]) === undefined
      ) return undefined;
      return "release.published";
    }
    case "deployment_status": {
      if (
        !onlyKeys(value, ["schemaVersion", "eventName", "action", "repository", "repositoryId", "deployment", "deploymentStatus"]) ||
        value["schemaVersion"] !== 1 || value["eventName"] !== expectedEventName ||
        value["repository"] !== expectedRepository || integerValue(value["repositoryId"]) === undefined ||
        action !== "created"
      ) return undefined;
      const deployment = record(value["deployment"]);
      const status = record(value["deploymentStatus"]);
      if (
        deployment === undefined || !onlyKeys(deployment, ["id", "ref", "sha"]) ||
        integerValue(deployment["id"]) === undefined ||
        stringValue(deployment["ref"], /^[^\u0000-\u001f\u007f\s]+$/u, 255) === undefined ||
        shaValue(deployment["sha"]) === undefined || status === undefined ||
        !onlyKeys(status, ["id", "state", "environment", "environmentUrl", "logUrl"]) ||
        integerValue(status["id"]) === undefined ||
        !inValues(status["state"], ["error", "failure", "inactive", "in_progress", "queued", "pending", "success"] as const) ||
        stringValue(status["environment"], /^[^\u0000-\u001f\u007f]+$/u, 255) === undefined ||
        optionalSafeUrl(status["environmentUrl"]) === undefined || optionalSafeUrl(status["logUrl"]) === undefined
      ) return undefined;
      return `deployment_status.${status["state"]}`;
    }
    case "push": {
      const push = record(value["push"]);
      if (
        !validBaseMinimizedEvent(value, expectedEventName, expectedRepository, "push") || action !== "updated" ||
        push === undefined || !onlyKeys(push, ["ref", "before", "after", "created", "deleted", "forced"]) ||
        stringValue(push["ref"], /^refs\/(?:heads|tags)\/[^\u0000-\u001f\u007f]+$/u, 512) === undefined ||
        shaValue(push["before"]) === undefined || shaValue(push["after"]) === undefined ||
        booleanValue(push["created"]) === undefined || booleanValue(push["deleted"]) === undefined ||
        booleanValue(push["forced"]) === undefined
      ) return undefined;
      return "push.updated";
    }
    default:
      return undefined;
  }
}
