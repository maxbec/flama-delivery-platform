import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  auditGitHubPolicy,
  type BranchProfilesPolicy,
  type GitHubPolicyAuditInput,
} from "./github-policy-audit.js";

const policy = JSON.parse(
  await readFile(new URL("../../../policies/branch-profiles.json", import.meta.url), "utf8"),
) as BranchProfilesPolicy;
const compliant = JSON.parse(
  await readFile(new URL("../../../tests/fixtures/github-policy/valid.json", import.meta.url), "utf8"),
) as GitHubPolicyAuditInput;

describe("GitHub repository policy audit", () => {
  it("passes the exact Fast profile without repository identifiers", () => {
    const result = auditGitHubPolicy(compliant, policy);
    expect(result).toMatchObject({
      schemaVersion: 1,
      status: "passed",
      profile: "fast",
      findingCount: 0,
      findings: [],
    });
    expect(result.contractDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("passes the exact Major integration and stable boundaries", () => {
    const major: GitHubPolicyAuditInput = {
      ...compliant,
      repository: { ...compliant.repository, profile: "major", defaultBranch: "dev" },
      protectedBranches: [
        {
          ...compliant.protectedBranches[0]!,
          name: "dev",
          requiredChecks: ["branch-guard / Flama Branch Guard", "Paperclip Preflight", "policy / Flama Policy Gate"],
        },
        {
          ...compliant.protectedBranches[0]!,
          name: "main",
          requiredChecks: ["branch-guard / Flama Branch Guard", "final / Flama Final Gate"],
        },
      ],
      merge: { squash: true, mergeCommit: true, rebase: false },
    };
    expect(auditGitHubPolicy(major, policy)).toMatchObject({ status: "passed", profile: "major" });
  });

  it("returns only redacted drift codes for a broadly unsafe repository", () => {
    const privateMarker = "private-repository-marker";
    const drifted = {
      ...compliant,
      repository: {
        ...compliant.repository,
        isFork: true,
        isArchived: true,
        defaultBranch: "dev",
        autoMerge: false,
        deleteHeadBranch: false,
      },
      protectedBranches: [{
        ...compliant.protectedBranches[0]!,
        requiredChecks: [],
        signedCommits: false,
        forcePush: true,
        bypassActorCount: 1,
      }],
      merge: { squash: false, mergeCommit: true, rebase: true },
      actions: {
        ...compliant.actions,
        defaultWorkflowPermissions: "write" as const,
        workflowCanApprovePullRequests: true,
        policy: "all" as const,
        thirdPartyFullShaPins: false,
        pullRequestTarget: true,
      },
      security: {
        vulnerabilityAlerts: false,
        dependabotAlerts: false,
        dependabotSecurityUpdates: false,
        secretScanning: { available: true, enabled: false },
        pushProtection: { available: true, enabled: false },
      },
      supplyChain: {
        protectedVersionTags: {
          available: true,
          enabled: false,
          pattern: "v*" as const,
          forceUpdate: true,
          deletion: true,
        },
        immutableReleases: { available: true, enabled: false },
      },
      deployment: {
        codeOwners: false,
        staleReviewDismissal: false,
        pathRestricted: false,
        exactShaApproval: false,
        // This repository deploys, so the boundary is one of the controls it
        // is failing rather than one that does not apply to it.
        deployable: true,
        environment: { exists: false, requiredReviewers: [], branchPolicyLimited: false },
      },
      githubApp: {
        ownerScoped: false,
        repositorySelection: "all" as const,
        installationTokens: "long_lived" as const,
        leastPrivilegePermissions: false,
        webhookEventsExact: false,
        administration: true,
        secretAdministration: true,
      },
      runners: {
        paperclipPreflight: "persistent" as const,
        githubVerification: "private_persistent" as const,
        deployment: "shared" as const,
        deploymentSeparated: false,
        publicPullRequestProductionNetwork: true,
      },
    } satisfies GitHubPolicyAuditInput;
    const result = auditGitHubPolicy(drifted, policy);

    expect(result.status).toBe("failed");
    expect(result.findings).toEqual(expect.arrayContaining([
      { code: "actions_trust_policy_drift", location: "actions" },
      { code: "archived_scope_denied", location: "repository" },
      { code: "branch_protection_drift", location: "branches" },
      { code: "default_branch_drift", location: "repository" },
      { code: "dependency_security_disabled", location: "security" },
      { code: "deployment_review_boundary_drift", location: "deployment" },
      { code: "fork_scope_denied", location: "repository" },
      { code: "github_app_scope_drift", location: "githubApp" },
      { code: "immutable_releases_disabled", location: "supplyChain" },
      { code: "merge_method_drift", location: "merge" },
      { code: "push_protection_disabled", location: "security" },
      { code: "repository_merge_automation_drift", location: "repository" },
      { code: "required_checks_drift", location: "branches" },
      { code: "runner_separation_drift", location: "runners" },
      { code: "secret_scanning_disabled", location: "security" },
      { code: "version_tag_protection_drift", location: "supplyChain" },
    ]));
    expect(JSON.stringify(result)).not.toContain(privateMarker);
  });

  it("accepts unavailable optional platform features without inventing support", () => {
    const unavailable: GitHubPolicyAuditInput = {
      ...compliant,
      security: {
        ...compliant.security,
        secretScanning: { available: false, enabled: false },
        pushProtection: { available: false, enabled: false },
      },
      supplyChain: {
        protectedVersionTags: {
          ...compliant.supplyChain.protectedVersionTags,
          available: false,
          enabled: false,
        },
        immutableReleases: { available: false, enabled: false },
      },
    };
    expect(auditGitHubPolicy(unavailable, policy)).toMatchObject({ status: "passed" });
  });
});

describe("Actions allow-list", () => {
  it("refuses a selected allow-list that blocks the platform's own workflows", () => {
    // Setting `selected` with no patterns is not a stricter policy, it is a
    // broken one: every reusable workflow stops resolving, including the Flama
    // gates themselves, and the audit used to call that compliant.
    const empty = { ...compliant, actions: { ...compliant.actions, allowedPatterns: [] } };
    expect(auditGitHubPolicy(empty, policy).findings.map(({ code }) => code))
      .toContain("actions_trust_policy_drift");

    // An owner pattern that does not cover the platform is the realistic case:
    // a navigaite repository allowing its own organization and nothing else.
    const missingPlatform = {
      ...compliant,
      actions: { ...compliant.actions, allowedPatterns: ["navigaite/*"] },
    };
    expect(auditGitHubPolicy(missingPlatform, policy).findings.map(({ code }) => code))
      .toContain("actions_trust_policy_drift");

    expect(auditGitHubPolicy(compliant, policy).findings.map(({ code }) => code))
      .not.toContain("actions_trust_policy_drift");
  });

  it("refuses an allow-list that blocks a reusable workflow the repository calls", () => {
    // The allow-list is derived per owner, but a repository may call a reusable
    // workflow belonging to a different owner. `edilio-app/edilio` and
    // `maxbec/platzl-finder` both call the legacy universal pipeline in
    // `navigaite/.github`, and an allow-list covering only their own owner and
    // the platform failed every run at startup while the audit called it
    // compliant. Every reusable workflow the repository actually calls has to
    // be covered, because none of them is ever github-owned or verified.
    const foreign = {
      ...compliant,
      actions: {
        ...compliant.actions,
        referencedReusableWorkflows: ["navigaite/.github"],
      },
    };
    expect(auditGitHubPolicy(foreign, policy).findings.map(({ code }) => code))
      .toContain("actions_trust_policy_drift");

    const covered = {
      ...foreign,
      actions: {
        ...foreign.actions,
        allowedPatterns: [...compliant.actions.allowedPatterns, "navigaite/.github/*"],
      },
    };
    expect(auditGitHubPolicy(covered, policy).findings.map(({ code }) => code))
      .not.toContain("actions_trust_policy_drift");

    // A whole-owner pattern covers it too, and the platform's own workflows
    // must keep passing on the pattern that already authorizes them.
    const byOwner = {
      ...foreign,
      actions: {
        ...foreign.actions,
        allowedPatterns: [...compliant.actions.allowedPatterns, "navigaite/*"],
      },
    };
    expect(auditGitHubPolicy(byOwner, policy).findings.map(({ code }) => code))
      .not.toContain("actions_trust_policy_drift");

    const platformOnly = {
      ...compliant,
      actions: {
        ...compliant.actions,
        referencedReusableWorkflows: ["maxbec/flama-delivery-platform"],
      },
    };
    expect(auditGitHubPolicy(platformOnly, policy).findings.map(({ code }) => code))
      .not.toContain("actions_trust_policy_drift");
  });
});

describe("Deployment review boundary", () => {
  const deployable = {
    ...compliant,
    deployment: {
      ...compliant.deployment,
      deployable: true,
      environment: { exists: true, requiredReviewers: ["maxbec"], branchPolicyLimited: true },
    },
  };

  it("passes a repository that deploys nothing", () => {
    // There is no production to protect, so demanding a review boundary here
    // reports drift that no change to the repository could ever clear. Every
    // repository in the estate was failing this control for that reason.
    const inert = {
      ...compliant,
      deployment: {
        ...compliant.deployment,
        deployable: false,
        environment: { exists: false, requiredReviewers: [], branchPolicyLimited: false },
      },
    };
    expect(auditGitHubPolicy(inert, policy).findings.map(({ code }) => code))
      .not.toContain("deployment_review_boundary_drift");
  });

  it("requires the boundary where a deployment actually happens", () => {
    expect(auditGitHubPolicy(deployable, policy).findings.map(({ code }) => code))
      .not.toContain("deployment_review_boundary_drift");

    // The environment rule is what holds production shut. Without it a green
    // pipeline deploys with nobody having looked at the commit.
    for (const broken of [
      { ...deployable.deployment, environment: { ...deployable.deployment.environment, exists: false } },
      { ...deployable.deployment, environment: { ...deployable.deployment.environment, requiredReviewers: [] } },
      { ...deployable.deployment, environment: { ...deployable.deployment.environment, branchPolicyLimited: false } },
      { ...deployable.deployment, codeOwners: false },
    ]) {
      expect(auditGitHubPolicy({ ...compliant, deployment: broken }, policy).findings.map(({ code }) => code))
        .toContain("deployment_review_boundary_drift");
    }
  });
});
