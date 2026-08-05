import { describe, expect, it } from "vitest";
import {
  planGitHubPolicyRepair,
  GitHubPolicyRepairError,
  type GitHubPolicyRepairInput,
} from "./github-policy-repair.js";

const input = (findings: readonly { code: string; location: string }[]): GitHubPolicyRepairInput => ({
  schemaVersion: 1,
  profile: "fast",
  contractDigest: `sha256:${"a".repeat(64)}`,
  findings: findings as GitHubPolicyRepairInput["findings"],
});

describe("safe reversible drift", () => {
  it("auto-repairs tightening settings that lose nothing", () => {
    const safe = [
      "repository_merge_automation_drift",
      "merge_method_drift",
      "actions_trust_policy_drift",
      "dependency_security_disabled",
      "secret_scanning_disabled",
      "push_protection_disabled",
      "immutable_releases_disabled",
      "required_checks_drift",
      "branch_protection_drift",
      "version_tag_protection_drift",
    ];

    const plan = planGitHubPolicyRepair(input(safe.map((code) => ({ code, location: "repository" }))));

    expect(plan.repairs).toHaveLength(safe.length);
    expect(plan.remediationCases).toHaveLength(0);
    expect(plan.status).toBe("planned");
    for (const repair of plan.repairs) {
      expect(repair.disposition).toBe("auto_repair");
    }
  });

  it("passes cleanly when the audit found no drift", () => {
    const plan = planGitHubPolicyRepair(input([]));

    expect(plan).toMatchObject({ status: "compliant", repairs: [], remediationCases: [] });
  });
});

describe("destructive drift", () => {
  it("never auto-repairs a change that breaks existing clones, refs, identity, or infrastructure", () => {
    const destructive = [
      "default_branch_drift",
      "protected_branch_set_drift",
      "github_app_scope_drift",
      "runner_separation_drift",
      "deployment_review_boundary_drift",
    ];

    const plan = planGitHubPolicyRepair(
      input(destructive.map((code) => ({ code, location: "repository" }))),
    );

    expect(plan.repairs).toHaveLength(0);
    expect(plan.remediationCases).toHaveLength(destructive.length);
    for (const remediation of plan.remediationCases) {
      expect(remediation.disposition).toBe("remediation_case");
    }
  });

  it("refuses every mutation on a fork or an archived repository", () => {
    for (const code of ["fork_scope_denied", "archived_scope_denied"]) {
      const plan = planGitHubPolicyRepair(
        input([{ code, location: "repository" }, { code: "merge_method_drift", location: "merge" }]),
      );

      expect(plan.status).toBe("mutation_denied");
      expect(plan.repairs).toHaveLength(0);
      expect(plan.remediationCases.map((entry) => entry.code)).toContain(code);
    }
  });

  it("refuses to plan anything from an invalid contract", () => {
    const plan = planGitHubPolicyRepair(
      input([
        { code: "github_policy_contract_invalid", location: "repository" },
        { code: "merge_method_drift", location: "merge" },
      ]),
    );

    expect(plan.status).toBe("mutation_denied");
    expect(plan.repairs).toHaveLength(0);
  });

  it("treats an unrecognized finding as destructive rather than assuming it is safe", () => {
    const plan = planGitHubPolicyRepair(input([{ code: "some_future_finding", location: "repository" }]));

    expect(plan.repairs).toHaveLength(0);
    expect(plan.remediationCases[0]).toMatchObject({
      code: "some_future_finding",
      disposition: "remediation_case",
      reason: "unclassified",
    });
  });
});

describe("repair plan integrity", () => {
  it("records each finding exactly once even when the audit repeated it", () => {
    const plan = planGitHubPolicyRepair(
      input([
        { code: "merge_method_drift", location: "merge" },
        { code: "merge_method_drift", location: "merge" },
      ]),
    );

    expect(plan.repairs).toHaveLength(1);
  });

  it("carries the audited contract digest so a plan cannot be applied to a different audit", () => {
    const plan = planGitHubPolicyRepair(input([{ code: "merge_method_drift", location: "merge" }]));

    expect(plan.contractDigest).toBe(`sha256:${"a".repeat(64)}`);
  });

  it("rejects a contract digest that is not a sha256 digest", () => {
    expect(() => planGitHubPolicyRepair({ ...input([]), contractDigest: "nope" }))
      .toThrow(GitHubPolicyRepairError);
  });

  it("rejects an unsupported schema version", () => {
    expect(() => planGitHubPolicyRepair({ ...input([]), schemaVersion: 2 as 1 }))
      .toThrow(GitHubPolicyRepairError);
  });
});
