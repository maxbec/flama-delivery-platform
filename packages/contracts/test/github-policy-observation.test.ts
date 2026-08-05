import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createSchemaValidator } from "../src/schema-validator.js";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

async function fixture(path: string): Promise<unknown> {
  return JSON.parse(await readFile(
    fileURLToPath(new URL(`../../../tests/fixtures/github-policy-observe/${path}`, import.meta.url)),
    "utf8",
  )) as unknown;
}

describe("github policy observation fixtures", () => {
  it("holds a golden observation the audit command accepts", async () => {
    const validator = await createSchemaValidator(repositoryRoot);

    const result = validator.validate("github-policy-audit-input", await fixture("expected-observation.json"));

    expect(result).toMatchObject({ ok: true });
  });

  it("holds an approved posture that matches the posture contract", async () => {
    const validator = await createSchemaValidator(repositoryRoot);

    const result = validator.validate("github-policy-posture", await fixture("posture.json"));

    expect(result).toMatchObject({ ok: true });
  });

  it("rejects a posture that omits every owner", async () => {
    const validator = await createSchemaValidator(repositoryRoot);
    const posture = await fixture("posture.json") as Record<string, unknown>;

    const result = validator.validate("github-policy-posture", { ...posture, owners: {} });

    expect(result.ok).toBe(false);
  });
});
