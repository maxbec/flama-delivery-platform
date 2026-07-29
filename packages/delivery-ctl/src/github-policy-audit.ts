import { createHash } from "node:crypto";

type Profile = "fast" | "major";
type FindingLocation =
  | "actions"
  | "branches"
  | "deployment"
  | "githubApp"
  | "merge"
  | "repository"
  | "runners"
  | "security"
  | "supplyChain";

interface BranchProfilePolicy {
  readonly defaultBranch: "main" | "dev";
  readonly requiredChecks?: readonly string[];
  readonly integrationChecks?: readonly string[];
  readonly stableChecks?: readonly string[];
}

export interface BranchProfilesPolicy {
  readonly version: 1;
  readonly profiles: Readonly<Record<Profile, BranchProfilePolicy>>;
  readonly common: {
    readonly pullRequestRequired: true;
    readonly strictChecks: true;
    readonly signedCommits: true;
    readonly conversationResolution: true;
    readonly forcePush: false;
    readonly branchDeletion: false;
    readonly autoMerge: true;
    readonly deleteHeadBranch: true;
    readonly normalBypassActors: readonly [];
  };
}

interface AvailableFeature {
  readonly available: boolean;
  readonly enabled: boolean;
}

export interface GitHubPolicyAuditInput {
  readonly schemaVersion: 1;
  readonly repository: {
    readonly profile: Profile;
    readonly visibility: "private" | "public";
    readonly isFork: boolean;
    readonly isArchived: boolean;
    readonly defaultBranch: "main" | "dev";
    readonly autoMerge: boolean;
    readonly deleteHeadBranch: boolean;
  };
  readonly protectedBranches: readonly {
    readonly name: "main" | "dev";
    readonly requiredChecks: readonly string[];
    readonly pullRequestRequired: boolean;
    readonly strictChecks: boolean;
    readonly signedCommits: boolean;
    readonly conversationResolution: boolean;
    readonly forcePush: boolean;
    readonly deletion: boolean;
    readonly bypassActorCount: number;
  }[];
  readonly merge: { readonly squash: boolean; readonly mergeCommit: boolean; readonly rebase: boolean };
  readonly actions: {
    readonly defaultWorkflowPermissions: "read" | "write";
    readonly workflowCanApprovePullRequests: boolean;
    readonly policy: "selected" | "all" | "local_only";
    readonly thirdPartyFullShaPins: boolean;
    readonly pullRequestTarget: boolean;
  };
  readonly security: {
    readonly vulnerabilityAlerts: boolean;
    readonly dependabotAlerts: boolean;
    readonly dependabotSecurityUpdates: boolean;
    readonly secretScanning: AvailableFeature;
    readonly pushProtection: AvailableFeature;
  };
  readonly supplyChain: {
    readonly protectedVersionTags: AvailableFeature & {
      readonly pattern: "v*";
      readonly forceUpdate: boolean;
      readonly deletion: boolean;
    };
    readonly immutableReleases: AvailableFeature;
  };
  readonly deployment: {
    readonly codeOwners: boolean;
    readonly staleReviewDismissal: boolean;
    readonly pathRestricted: boolean;
    readonly exactShaApproval: boolean;
  };
  readonly githubApp: {
    readonly ownerScoped: boolean;
    readonly repositorySelection: "selected" | "all";
    readonly installationTokens: "short_lived" | "long_lived";
    readonly leastPrivilegePermissions: boolean;
    readonly webhookEventsExact: boolean;
    readonly administration: boolean;
    readonly secretAdministration: boolean;
  };
  readonly runners: {
    readonly paperclipPreflight: "ephemeral" | "persistent";
    readonly githubVerification: "github_hosted_or_disposable" | "private_persistent";
    readonly deployment: "hardened_separate" | "shared";
    readonly deploymentSeparated: boolean;
    readonly publicPullRequestProductionNetwork: boolean;
  };
  readonly mutationAllowed: false;
}

export interface GitHubPolicyAuditFinding {
  readonly code: string;
  readonly location: FindingLocation;
}

export interface GitHubPolicyAuditResult {
  readonly schemaVersion: 1;
  readonly status: "passed" | "failed";
  readonly profile: Profile;
  readonly findingCount: number;
  readonly findings: readonly GitHubPolicyAuditFinding[];
  readonly contractDigest: string;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(
      ([key, nested]) => [key, stableValue(nested)],
    ));
  }
  return value;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex")}`;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function featureCompliant(feature: AvailableFeature): boolean {
  return feature.available ? feature.enabled : !feature.enabled;
}

export function auditGitHubPolicy(
  input: GitHubPolicyAuditInput,
  policy: BranchProfilesPolicy,
): GitHubPolicyAuditResult {
  const findings: GitHubPolicyAuditFinding[] = [];
  const add = (code: string, location: FindingLocation): void => {
    findings.push({ code, location });
  };
  const profile = policy.profiles[input.repository.profile];
  if (input.schemaVersion !== 1 || input.mutationAllowed !== false || policy.version !== 1 || profile === undefined) {
    add("github_policy_contract_invalid", "repository");
  }
  if (input.repository.isFork) add("fork_scope_denied", "repository");
  if (input.repository.isArchived) add("archived_scope_denied", "repository");
  if (profile !== undefined && input.repository.defaultBranch !== profile.defaultBranch) {
    add("default_branch_drift", "repository");
  }
  if (!input.repository.autoMerge || !input.repository.deleteHeadBranch) {
    add("repository_merge_automation_drift", "repository");
  }

  const expectedBranches = input.repository.profile === "fast"
    ? [{ name: "main" as const, checks: profile?.requiredChecks ?? [] }]
    : [
      { name: "dev" as const, checks: profile?.integrationChecks ?? [] },
      { name: "main" as const, checks: profile?.stableChecks ?? [] },
    ];
  const observedBranchNames = input.protectedBranches.map(({ name }) => name);
  if (
    new Set(observedBranchNames).size !== observedBranchNames.length ||
    !sameStrings(observedBranchNames, expectedBranches.map(({ name }) => name))
  ) add("protected_branch_set_drift", "branches");
  for (const expected of expectedBranches) {
    const observed = input.protectedBranches.find(({ name }) => name === expected.name);
    if (observed === undefined || !sameStrings(observed.requiredChecks, expected.checks)) {
      add("required_checks_drift", "branches");
    }
    if (observed === undefined) continue;
    if (
      observed.pullRequestRequired !== policy.common.pullRequestRequired ||
      observed.strictChecks !== policy.common.strictChecks || observed.signedCommits !== policy.common.signedCommits ||
      observed.conversationResolution !== policy.common.conversationResolution ||
      observed.forcePush !== policy.common.forcePush || observed.deletion !== policy.common.branchDeletion ||
      observed.bypassActorCount !== policy.common.normalBypassActors.length
    ) add("branch_protection_drift", "branches");
  }

  const expectedMergeCommit = input.repository.profile === "major";
  if (!input.merge.squash || input.merge.mergeCommit !== expectedMergeCommit || input.merge.rebase) {
    add("merge_method_drift", "merge");
  }
  if (
    input.actions.defaultWorkflowPermissions !== "read" || input.actions.workflowCanApprovePullRequests ||
    input.actions.policy !== "selected" || !input.actions.thirdPartyFullShaPins || input.actions.pullRequestTarget
  ) add("actions_trust_policy_drift", "actions");
  if (
    !input.security.vulnerabilityAlerts || !input.security.dependabotAlerts ||
    !input.security.dependabotSecurityUpdates
  ) add("dependency_security_disabled", "security");
  if (!featureCompliant(input.security.secretScanning)) add("secret_scanning_disabled", "security");
  if (!featureCompliant(input.security.pushProtection)) add("push_protection_disabled", "security");

  const tags = input.supplyChain.protectedVersionTags;
  if (
    (tags.available && (!tags.enabled || tags.pattern !== "v*" || tags.forceUpdate || tags.deletion)) ||
    (!tags.available && (tags.enabled || tags.forceUpdate || tags.deletion))
  ) {
    add("version_tag_protection_drift", "supplyChain");
  }
  if (!featureCompliant(input.supplyChain.immutableReleases)) add("immutable_releases_disabled", "supplyChain");
  if (
    !input.deployment.codeOwners || !input.deployment.staleReviewDismissal ||
    !input.deployment.pathRestricted || !input.deployment.exactShaApproval
  ) add("deployment_review_boundary_drift", "deployment");
  if (
    !input.githubApp.ownerScoped || input.githubApp.repositorySelection !== "selected" ||
    input.githubApp.installationTokens !== "short_lived" || !input.githubApp.leastPrivilegePermissions ||
    !input.githubApp.webhookEventsExact || input.githubApp.administration || input.githubApp.secretAdministration
  ) add("github_app_scope_drift", "githubApp");
  if (
    input.runners.paperclipPreflight !== "ephemeral" ||
    input.runners.githubVerification !== "github_hosted_or_disposable" ||
    input.runners.deployment !== "hardened_separate" || !input.runners.deploymentSeparated ||
    input.runners.publicPullRequestProductionNetwork
  ) add("runner_separation_drift", "runners");

  findings.sort((left, right) => left.code === right.code
    ? left.location.localeCompare(right.location)
    : left.code.localeCompare(right.code));
  return {
    schemaVersion: 1,
    status: findings.length === 0 ? "passed" : "failed",
    profile: input.repository.profile,
    findingCount: findings.length,
    findings,
    contractDigest: digest({ schemaVersion: 1, profile: input.repository.profile, policy }),
  };
}
