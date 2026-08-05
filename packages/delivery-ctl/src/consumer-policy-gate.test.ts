import { describe, expect, it } from "vitest";

// The gate is a standalone script the consumer workflows run from the pinned
// platform SHA, so it is imported here rather than reimplemented. It ships as
// plain JavaScript with no declarations, which is what the assertion below is.
const gate: { assertContract: (contract: unknown, profile: string) => void } =
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  await import(/* @vite-ignore */ "../../../scripts/consumer-policy-gate.mjs" as string);

const contract = {
  schemaVersion: 1,
  repository: { owner: "navigaite", name: "example", visibility: "private" },
  paperclip: { company: "// Navigaite", projectId: "p", workspaceId: "w" },
  profile: "major",
  branches: { default: "dev", stable: "main", featureTarget: "dev" },
  commands: Object.fromEntries(
    ["buildable", "affected", "full", "smoke", "health"].map((n) => [n, `./scripts/delivery ${n}`]),
  ),
  changeDetection: {
    failClosed: true,
    broadenOn: ["lockfiles", "authentication", "database_schema", "uncertain_detection"],
  },
  release: { enabled: true, strategy: "release-please", impactSource: "paperclip_task", type: "node" },
  deployment: { deployable: false, provider: "none", manifestPath: ".deploy/production.yaml" },
  secrets: {
    source: "infisical",
    projectSlug: "example-slug",
    paths: { development: "/development" },
    exceptionsFile: ".flama/secret-exceptions.json",
  },
  platform: { repository: "maxbec/flama-delivery-platform", version: "0.1.0" },
};

describe("consumer policy gate — secret binding", () => {
  it("accepts a contract whose Infisical project lives in another organization", () => {
    // Two repositories already ship this shape and the delivery-contract schema
    // permits it. The gate required exactly four keys, so it rejected the very
    // contract the platform generates for a cross-organization project.
    const crossOrg = {
      ...contract,
      secrets: { ...contract.secrets, organization: "maimaldrei-gmbh" },
    };

    expect(() => gate.assertContract(crossOrg, "major")).not.toThrow();
    expect(() => gate.assertContract(contract, "major")).not.toThrow();
  });

  it("still refuses an unknown key or a missing required one", () => {
    expect(() =>
      gate.assertContract({ ...contract, secrets: { ...contract.secrets, sneaky: "x" } }, "major"),
    ).toThrow();
    const { exceptionsFile: _dropped, ...withoutExceptions } = contract.secrets;
    expect(() =>
      gate.assertContract({ ...contract, secrets: withoutExceptions }, "major"),
    ).toThrow();
    expect(() =>
      gate.assertContract({ ...contract, secrets: { ...contract.secrets, source: "vault" } }, "major"),
    ).toThrow();
  });
});
