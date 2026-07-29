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
          requiredChecks: ["Branch Guard", "Paperclip Preflight", "Policy Gate"],
        },
        {
          ...compliant.protectedBranches[0]!,
          name: "main",
          requiredChecks: ["Branch Guard", "Final Gate"],
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
