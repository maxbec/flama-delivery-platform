import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createSchemaValidator } from "./schema-validator.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

async function readJson(relativePath: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(`../../../${relativePath}`, import.meta.url), "utf8"));
}

describe("Paperclip platform contracts", () => {
  it.each(["project-bootstrap", "feature-fix", "release-deployment"])(
    "validates the %s lifecycle",
    async (name) => {
      const validator = await createSchemaValidator(repositoryRoot);
      const lifecycle = await readJson(`lifecycles/${name}.json`);

      expect(validator.validate("paperclip-lifecycle", lifecycle)).toEqual({
        ok: true,
        schema: "paperclip-lifecycle",
      });
    },
  );

  it.each([
    "maxbec-delivery-controller",
    "navigaite-delivery-controller",
    "edilio-delivery-controller",
    "flama-governance-controller",
  ])("validates the %s authority contract", async (name) => {
    const validator = await createSchemaValidator(repositoryRoot);
    const controller = await readJson(`lifecycles/controllers/${name}.json`);

    expect(validator.validate("paperclip-controller", controller)).toEqual({
      ok: true,
      schema: "paperclip-controller",
    });
  });

  it("rejects governance write authority", async () => {
    const validator = await createSchemaValidator(repositoryRoot);
    const controller = (await readJson(
      "lifecycles/controllers/flama-governance-controller.json",
    )) as Record<string, unknown>;
    const authority = controller["authority"] as Record<string, unknown>;
    const unsafe = { ...controller, authority: { ...authority, write: ["github_pull_requests"] } };

    expect(validator.validate("paperclip-controller", unsafe).ok).toBe(false);
  });

  it("keeps transitions within their declared state graph", async () => {
    for (const name of ["project-bootstrap", "feature-fix", "release-deployment"]) {
      const lifecycle = (await readJson(`lifecycles/${name}.json`)) as {
        states: readonly string[];
        transitions: ReadonlyArray<{ from: string; to: string }>;
      };
      const states = new Set(lifecycle.states);
      expect(lifecycle.transitions.every(({ from, to }) => states.has(from) && states.has(to))).toBe(true);
    }
  });
});
