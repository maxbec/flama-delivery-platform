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
