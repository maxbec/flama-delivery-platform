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
    /** False when the plan does not sell branch protection for this repository. */
    readonly protectionAvailable?: boolean;
  }[];
  /** Controls that stand in where a platform feature is unavailable. */
  readonly substituteControls?: { readonly pushGuard: boolean };
  readonly merge: { readonly squash: boolean; readonly mergeCommit: boolean; readonly rebase: boolean };
  readonly actions: {
    readonly defaultWorkflowPermissions: "read" | "write";
    readonly workflowCanApprovePullRequests: boolean;
    readonly policy: "selected" | "all" | "local_only";
    readonly thirdPartyFullShaPins: boolean;
    readonly pullRequestTarget: boolean;
    readonly allowedPatterns: readonly string[];
    /** Cross-repository reusable workflows the default branch actually calls. */
    readonly referencedReusableWorkflows: readonly string[];
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
    /** Whether this repository deploys anything at all. */
    readonly deployable: boolean;
    /** The GitHub Environment the deploy job runs through. */
    readonly environment: {
      readonly exists: boolean;
      readonly requiredReviewers: readonly string[];
      readonly branchPolicyLimited: boolean;
    };
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

const platformActionsPattern = "maxbec/flama-delivery-platform/*";

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
  // GitHub refuses branch protection on a private repository under a free plan.
  // Reporting drift a repository cannot clear at any price is the same defect as
  // demanding a deploy boundary of something that deploys nothing: the control
  // never passes, and a control that never passes gets ignored.
  //
  // Where it is unavailable the audit requires the substitute instead — the push
  // guard, which watches the stable branch and raises an alarm for a commit that
  // did not arrive through a gated pull request. That is detective where
  // protection is preventive, and it is what is actually available.
  const protectionUnavailable = input.protectedBranches.some(
    (branch) => branch.protectionAvailable === false,
  );
  if (protectionUnavailable && input.substituteControls?.pushGuard !== true) {
    add("push_guard_missing", "branches");
  }
  for (const expected of expectedBranches) {
    const observed = input.protectedBranches.find(({ name }) => name === expected.name);
    if (observed?.protectionAvailable === false) continue;
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
  // A `selected` policy whose allow-list omits the platform is not a stricter
  // policy, it is a broken one: the Flama gates are reusable workflows from
  // another repository, so they stop resolving and every run fails at startup.
  const allowsPlatform = input.actions.allowedPatterns.some(
    (pattern) => pattern === platformActionsPattern || pattern === "maxbec/*",
  );
  // The allow-list is derived per owner, but a repository may call a reusable
  // workflow from another owner — the legacy universal pipeline in
  // `navigaite/.github` is one, and the platform narrowed two repositories out
  // of it. A reusable workflow is never github-owned and never verified, so the
  // allow-list is the only thing that can authorize it, and one that is missing
  // fails every run at startup while every other control still looks compliant.
  const allowsEveryReusableWorkflow = input.actions.referencedReusableWorkflows.every(
    (reference) => {
      const owner = reference.slice(0, reference.indexOf("/"));
      return input.actions.allowedPatterns.some(
        (pattern) => pattern === `${reference}/*` || pattern === `${owner}/*`,
      );
    },
  );
  if (
    input.actions.defaultWorkflowPermissions !== "read" || input.actions.workflowCanApprovePullRequests ||
    input.actions.policy !== "selected" || !input.actions.thirdPartyFullShaPins ||
    input.actions.pullRequestTarget || !allowsPlatform || !allowsEveryReusableWorkflow
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
  // The boundary is measured where it is enforced: on the deploy path. A
  // repository that deploys nothing has no production to hold shut, and
  // demanding a review boundary of it reports drift no change could clear.
  //
  // Where a deployment does happen, the Environment rule is what stops it:
  // `deployment-pr` already validates the review against the exact head SHA and
  // permits only the production manifest to change, and the Environment adds
  // the reviewer gate and confines deploys to the stable branch. Requiring an
  // approving review on every pull request in the estate would enforce the same
  // thing in the wrong place, on every change rather than on the deploy.
  if (input.deployment.deployable) {
    const environment = input.deployment.environment;
    if (
      !input.deployment.codeOwners || !environment.exists ||
      environment.requiredReviewers.length === 0 || !environment.branchPolicyLimited
    ) add("deployment_review_boundary_drift", "deployment");
  }
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
