import { describe, expect, it } from "vitest";
import { classifyInventory } from "./classify.js";

describe("classify inventory", () => {
  it("classifies only mutable consumers and preserves explicit major signals", () => {
    const result = classifyInventory({
      repositories: [
        {
          nameWithOwner: "maxbec/api",
          disposition: "in_scope",
          mutationAllowed: true,
          defaultBranch: "main",
          stack: ["node"],
          providerIndicators: [],
        },
        {
          nameWithOwner: "navigaite/platform",
          disposition: "in_scope",
          mutationAllowed: true,
          defaultBranch: "dev",
          stack: ["node-monorepo"],
          providerIndicators: ["docker"],
        },
        {
          nameWithOwner: "edilio-app/upstream-fork",
          disposition: "excluded_fork",
          mutationAllowed: false,
          defaultBranch: "main",
          stack: ["node"],
          providerIndicators: [],
        },
      ],
    });

    expect(result).toEqual({
      schemaVersion: 1,
      total: 2,
      profiles: { fast: 1, major: 1 },
      repositories: [
        { nameWithOwner: "maxbec/api", profile: "fast", reasons: [] },
        {
          nameWithOwner: "navigaite/platform",
          profile: "major",
          reasons: ["integration_branch", "monorepo", "deployment_provider"],
        },
      ],
    });
  });

  it("fails closed when an in-scope repository is marked immutable", () => {
    expect(() =>
      classifyInventory({
        repositories: [
          {
            nameWithOwner: "maxbec/conflict",
            disposition: "in_scope",
            mutationAllowed: false,
            defaultBranch: "main",
            stack: [],
            providerIndicators: [],
          },
        ],
      }),
    ).toThrow(/inconsistent mutation policy/);
  });
});

describe("approved profile overrides", () => {
  // The rules infer intent from what a repository contains, and sometimes that
  // inference is wrong: `platzl-finder` and `subscription-manager` ship
  // Dockerfiles, which reads as a deployment provider and so as the two-branch
  // profile, but Max runs both single-branch. An override records that decision
  // in the approved policy instead of leaving someone to hand-edit a contract,
  // which the Policy Gate would reject anyway.
  const repositories = [{
    nameWithOwner: "alpha/deploys-but-single-branch",
    disposition: "in_scope" as const,
    mutationAllowed: true,
    defaultBranch: "main",
    stack: [],
    providerIndicators: ["docker"],
  }];

  it("classifies by the rules when no override applies", () => {
    const result = classifyInventory({ repositories });
    expect(result.repositories[0]).toMatchObject({
      profile: "major",
      reasons: ["deployment_provider"],
    });
  });

  it("takes the approved override and says so", () => {
    const result = classifyInventory({
      repositories,
      profileOverrides: { "alpha/deploys-but-single-branch": "fast" },
    });
    expect(result.repositories[0]).toMatchObject({
      profile: "fast",
      reasons: ["explicit_override"],
    });
    expect(result.profiles).toMatchObject({ fast: 1, major: 0 });
  });

  it("refuses an override for a repository it is not classifying", () => {
    // A typo in the policy would otherwise silently do nothing, and the
    // repository would keep the profile the override was written to change.
    expect(() => classifyInventory({
      repositories,
      profileOverrides: { "alpha/no-such-repository": "fast" },
    })).toThrow();
  });
});
