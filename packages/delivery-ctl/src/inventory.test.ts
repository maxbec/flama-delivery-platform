import { describe, expect, it } from "vitest";
import { auditInventory, type InventoryAuditInput } from "./inventory.js";

function inventory(): InventoryAuditInput {
  return {
    schemaVersion: 1,
    observedAt: "2026-07-28T20:00:00Z",
    source: { mode: "fixture" },
    policyVersion: 1,
    summary: {
      total: 3,
      inScope: 1,
      private: 0,
      public: 1,
      forks: 1,
      archived: 0,
      platform: 1,
      mutationAllowed: 2,
      mutationDenied: 1,
    },
    owners: {
      maxbec: {
        expected: { inScope: 1, private: 0, public: 1, forks: 1, archived: 0 },
        observed: { inScope: 1, private: 0, public: 1, forks: 1, archived: 0 },
      },
    },
    repositories: [
      { owner: "maxbec", isFork: false, isArchived: false, isPrivate: false, disposition: "in_scope", mutationAllowed: true },
      { owner: "maxbec", isFork: false, isArchived: false, isPrivate: false, disposition: "platform", mutationAllowed: true },
      { owner: "maxbec", isFork: true, isArchived: false, isPrivate: false, disposition: "excluded_fork", mutationAllowed: false },
    ],
  };
}

describe("inventory audit", () => {
  it("recomputes counts and returns only aggregate evidence", () => {
    const input = inventory();
    const result = auditInventory(input);

    expect(result).toMatchObject({
      status: "passed",
      summary: input.summary,
      owners: { maxbec: { countsMatch: true, observed: input.owners["maxbec"]!.observed } },
    });
    expect(result.inventoryDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(JSON.stringify(result)).not.toContain("nameWithOwner");
  });

  it("fails when summary counts do not match the records", () => {
    const input = inventory();
    expect(() => auditInventory({ ...input, summary: { ...input.summary, inScope: 2 } }))
      .toThrowError(expect.objectContaining({ code: "inventory_count_mismatch" }));
  });

  it("fails when an excluded repository is mutable", () => {
    const input = inventory();
    const repositories = input.repositories.map((repository, index) =>
      index === 2 ? { ...repository, mutationAllowed: true } : repository,
    );
    expect(() => auditInventory({ ...input, repositories }))
      .toThrowError(expect.objectContaining({ code: "inventory_scope_violation" }));
  });
});
