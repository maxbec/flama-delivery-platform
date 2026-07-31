import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createSchemaValidator } from "./schema-validator.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const fixture = new URL("../test/fixtures/delivery-contract.valid.json", import.meta.url);

describe("schema validator", () => {
  it("accepts a delivery contract and returns a stable schema name", async () => {
    const validator = await createSchemaValidator(repositoryRoot);
    const input: unknown = JSON.parse(await readFile(fixture, "utf8"));

    expect(validator.validate("delivery-contract", input)).toEqual({
      ok: true,
      schema: "delivery-contract",
    });
  });

  it("returns structural errors without echoing secret input values", async () => {
    const validator = await createSchemaValidator(repositoryRoot);
    const secretValue = "must-never-appear";

    const result = validator.validate("delivery-contract", {
      token: secretValue,
    });

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secretValue);
    if (!result.ok) {
      expect(result.errors.every((error) => !Object.hasOwn(error, "data"))).toBe(true);
    }
  });

  it("rejects secret values added to audit exception records", async () => {
    const validator = await createSchemaValidator(repositoryRoot);
    const secretValue = "must-never-appear";
    const result = validator.validate("secrets-audit-input", {
      schemaVersion: 1,
      repository: { visibility: "private", isFork: false },
      infisical: {
        sourceOfTruth: true,
        projectSlug: "api",
        paths: ["/production"],
        machineIdentity: { method: "oidc", hardcodedClaims: true },
      },
      publicPullRequest: {
        secrets: false,
        idToken: false,
        infisical: false,
        trustedCacheWrite: false,
        privateRunner: false,
      },
      destinationSecrets: [],
      exceptions: [
        {
          key: "DEPLOY_TOKEN",
          destination: "github_environment_secret",
          reason: "Provider requires destination storage",
          owner: "max",
          scope: "environment",
          rotationDays: 30,
          expiresAt: "2026-09-01",
          reviewAfter: "2026-08-15",
          status: "approved",
          value: secretValue,
        },
      ],
      repositoryVariables: [],
    });

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secretValue);
  });

  it("lets a delivery contract name the organization holding its secret project", async () => {
    const validator = await createSchemaValidator(repositoryRoot);
    const contract = JSON.parse(await readFile(
      fileURLToPath(new URL("../test/fixtures/delivery-contract.valid.json", import.meta.url)),
      "utf8",
    )) as Record<string, unknown>;
    const secrets = contract["secrets"] as Record<string, unknown>;

    // A project slug alone is ambiguous once a company's repositories live in
    // more than one Infisical organization.
    const scoped = {
      ...contract,
      secrets: { ...secrets, organization: "maimaldrei-gmbh" },
    };

    expect(validator.validate("delivery-contract", scoped)).toMatchObject({ ok: true });
  });

  it("identifies a secret project by id when its slug is unreachable", async () => {
    const validator = await createSchemaValidator(repositoryRoot);
    const contract = JSON.parse(await readFile(
      fileURLToPath(new URL("../test/fixtures/delivery-contract.valid.json", import.meta.url)),
      "utf8",
    )) as Record<string, unknown>;
    const secrets = contract["secrets"] as Record<string, unknown>;
    const { projectSlug: _slug, ...withoutSlug } = secrets;

    // Infisical identifies a project by id in its own URLs and in the config
    // repositories check in, and a slug cannot be read across an organization
    // boundary at all.
    const byId = {
      ...contract,
      secrets: {
        ...withoutSlug,
        projectId: "58fb7746-46fc-4c88-861b-0b2dc159522b",
        organization: "maimaldrei-gmbh",
      },
    };
    expect(validator.validate("delivery-contract", byId)).toMatchObject({ ok: true });

    // One of the two identifiers is still mandatory.
    const neither = { ...contract, secrets: withoutSlug };
    expect(validator.validate("delivery-contract", neither).ok).toBe(false);
  });
});
