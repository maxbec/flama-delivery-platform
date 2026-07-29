import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createSchemaValidator } from "../../../packages/contracts/src/schema-validator.js";
import {
  collectGovernance,
  governanceTargets,
  GovernanceError,
  parseGovernanceInput,
  type GitHubGovernanceReader,
  type GovernanceInput,
  type GovernanceReaders,
  type PaperclipGovernanceReader,
  type PaperclipGovernanceSnapshot,
} from "./governance.js";

const companyIds = {
  maxbec: "11111111-1111-4111-8111-111111111111",
  navigaite: "22222222-2222-4222-8222-222222222222",
  edilio: "33333333-3333-4333-8333-333333333333",
} as const;
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

const input: GovernanceInput = {
  schemaVersion: 1,
  window: { from: "2026-07-01T00:00:00.000Z", to: "2026-07-08T00:00:00.000Z" },
  scopes: [
    {
      key: "maxbec",
      company: "Private",
      companyId: companyIds.maxbec,
      githubOwner: "maxbec",
      controller: "maxbec-delivery-controller",
      repositories: [{ name: "alpha", profile: "fast", finalWorkflow: "Final Gate" }],
    },
    {
      key: "navigaite",
      company: "// Navigaite",
      companyId: companyIds.navigaite,
      githubOwner: "navigaite",
      controller: "navigaite-delivery-controller",
      repositories: [{ name: "bravo", profile: "major", finalWorkflow: "Final Gate" }],
    },
    {
      key: "edilio",
      company: "Edilio",
      companyId: companyIds.edilio,
      githubOwner: "edilio",
      controller: "edilio-delivery-controller",
      repositories: [],
    },
  ],
};

const identity = {
  maxbec: { company: "Private", controller: "maxbec-delivery-controller" },
  navigaite: { company: "// Navigaite", controller: "navigaite-delivery-controller" },
  edilio: { company: "Edilio", controller: "edilio-delivery-controller" },
} as const;

function snapshot(key: keyof typeof identity): PaperclipGovernanceSnapshot {
  return {
    company: { id: companyIds[key], name: identity[key].company, status: "active" },
    agents: [{
      id: "44444444-4444-4444-8444-444444444444",
      companyId: companyIds[key],
      name: identity[key].controller,
      role: "devops",
      adapterType: "process",
      budgetMonthlyCents: 0,
      status: key === "edilio" ? "pending_approval" : "paused",
      desiredSkills: ["flama-paperclip-delivery"],
      permissions: { canCreateAgents: false, canCreateSkills: false, canAssignTasks: false },
      metadata: { managedBy: "flama-delivery-platform", topologyVersion: 1 },
    }],
    pipelines: [
      { key: "flama-project-bootstrap-v1", enforceTransitions: true, archivedAt: null },
      { key: "flama-feature-fix-v1", enforceTransitions: true, archivedAt: null },
      { key: "flama-release-deployment-v1", enforceTransitions: true, archivedAt: null },
    ],
  };
}

function readers(): GovernanceReaders {
  const paperclip = new Map<string, PaperclipGovernanceReader>(
    (["maxbec", "navigaite", "edilio"] as const).map((key) => [key, { readSnapshot: async () => snapshot(key) }]),
  );
  const githubReader: GitHubGovernanceReader = {
    async listRuns(_owner, repository) {
      if (repository !== "alpha" && repository !== "bravo") return [];
      const major = repository === "bravo";
      return [{
        id: major ? 202 : 101,
        name: "Final Gate",
        event: "pull_request",
        status: "completed",
        conclusion: "success",
        runAttempt: major ? 2 : 1,
        createdAt: "2026-07-02T10:00:00.000Z",
        runStartedAt: "2026-07-02T10:00:10.000Z",
        updatedAt: major ? "2026-07-02T10:05:10.000Z" : "2026-07-02T10:02:10.000Z",
        baseRefs: ["main"],
      }];
    },
    async listJobs(_owner, repository) {
      return [{
        status: "completed",
        conclusion: "success",
        startedAt: "2026-07-02T10:00:10.000Z",
        completedAt: repository === "bravo" ? "2026-07-02T10:05:00.000Z" : "2026-07-02T10:02:00.000Z",
      }];
    },
  };
  return {
    paperclip(key) {
      const value = paperclip.get(key);
      if (value === undefined) throw new Error("missing reader");
      return value;
    },
    github() {
      return githubReader;
    },
  };
}

describe("governance collection", () => {
  it("keeps compiled thresholds synchronized with the pooled budget policy", async () => {
    const policy = JSON.parse(await readFile(new URL("../../../policies/ci-budget.json", import.meta.url), "utf8")) as {
      targets: {
        fast: { p50WallMinutes: number; p95WallMinutes: number; runnerMinutesPerMainPr: number };
        major: { p50WallMinutes: number; p95WallMinutes: number; runnerMinutesPerPromotion: number };
      };
    };
    expect(governanceTargets).toEqual({
      fast: {
        p50Wall: policy.targets.fast.p50WallMinutes * 60,
        p95Wall: policy.targets.fast.p95WallMinutes * 60,
        runner: policy.targets.fast.runnerMinutesPerMainPr * 60,
      },
      major: {
        p50Wall: policy.targets.major.p50WallMinutes * 60,
        p95Wall: policy.targets.major.p95WallMinutes * 60,
        runner: policy.targets.major.runnerMinutesPerPromotion * 60,
      },
    });
  });

  it("aggregates metadata without emitting private identifiers", async () => {
    const result = await collectGovernance(input, readers());
    const validator = await createSchemaValidator(repositoryRoot);
    expect(validator.validate("governance-input", input).ok).toBe(true);
    expect(validator.validate("governance-result", result).ok).toBe(true);
    expect(result.status).toBe("attention");
    expect(result.scopes.map(({ key }) => key)).toEqual(["maxbec", "navigaite", "edilio"]);
    expect(result.scopes[0]?.delivery.fast).toMatchObject({
      status: "compliant",
      samples: 1,
      wallSeconds: { p50: 120, p95: 120 },
      queueSeconds: { p50: 10, p95: 10 },
      runnerSeconds: { p50: 110, p95: 110 },
      retryRuns: 0,
    });
    expect(result.scopes[1]?.delivery.major.retryRuns).toBe(1);
    expect(result.scopes[2]?.paperclip.controller).toBe("pending_approval");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(companyIds.maxbec);
    expect(serialized).not.toContain("alpha");
    expect(serialized).not.toContain("101");
  });

  it("rejects cross-company scope substitution", () => {
    const changed = structuredClone(input) as unknown as { scopes: Array<Record<string, unknown>> };
    changed.scopes[0]!["company"] = "Edilio";
    expect(() => parseGovernanceInput(changed)).toThrowError(
      expect.objectContaining<Partial<GovernanceError>>({ code: "governance_input_invalid" }),
    );
  });

  it("rejects duplicate repository selectors", () => {
    const changed = structuredClone(input) as unknown as { scopes: Array<{ repositories: unknown[] }> };
    changed.scopes[0]!.repositories.push({ name: "ALPHA", profile: "fast", finalWorkflow: "Final Gate" });
    expect(() => parseGovernanceInput(changed)).toThrowError(
      expect.objectContaining<Partial<GovernanceError>>({ code: "governance_input_invalid" }),
    );
  });

  it("fails when read metadata has impossible timestamps", async () => {
    const base = readers();
    const invalid: GovernanceReaders = {
      paperclip: base.paperclip,
      github() {
        return {
          async listRuns() {
            return [{
              id: 1,
              name: "Final Gate",
              event: "pull_request",
              status: "completed",
              conclusion: "success",
              runAttempt: 1,
              createdAt: "2026-07-02T10:00:00.000Z",
              runStartedAt: "2026-07-02T09:59:00.000Z",
              updatedAt: "2026-07-02T10:01:00.000Z",
              baseRefs: ["main"],
            }];
          },
          async listJobs() {
            return [{ status: "completed", conclusion: "success", startedAt: null, completedAt: null }];
          },
        };
      },
    };
    await expect(collectGovernance(input, invalid)).rejects.toMatchObject({ code: "governance_metadata_invalid" });
  });
});
