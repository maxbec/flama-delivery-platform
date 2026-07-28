import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { RenderConflictError, renderTemplates, type RenderInput } from "./render.js";

const input: RenderInput = {
  schemaVersion: 1,
  repository: "maxbec/example",
  profile: "fast",
  platformRef: "a".repeat(40),
  platformVersion: "0.1.0",
  paperclip: {
    company: "Private",
    projectId: "project-example",
    workspaceId: "workspace-example",
    appSlug: "flama-maxbec-delivery",
  },
  release: { enabled: true, type: "node", currentVersion: "1.2.3" },
  dependabot: { ecosystems: [{ packageEcosystem: "npm", directory: "/" }] },
  commands: {
    buildable: ["pnpm", "run", "build"],
    affected: ["pnpm", "test"],
    full: ["pnpm", "test"],
    smoke: ["pnpm", "run", "smoke"],
    health: ["pnpm", "run", "health"],
  },
};

const repositoryRoot = new URL("../../../", import.meta.url).pathname;

describe("template renderer", () => {
  it("dry-runs without writing, then renders and rerenders idempotently", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "flama-render-"));
    const dryRun = await renderTemplates({ repositoryRoot, outputRoot, input, dryRun: true });

    expect(dryRun.files).toHaveLength(10);
    expect(dryRun.files.every(({ status }) => status === "planned")).toBe(true);
    await expect(access(join(outputRoot, ".github", "dependabot.yml"))).rejects.toThrow();

    const rendered = await renderTemplates({ repositoryRoot, outputRoot, input, dryRun: false });
    expect(rendered.files.every(({ status }) => status === "created")).toBe(true);
    const policy = await readFile(join(outputRoot, ".github/workflows/flama-policy.yml"), "utf8");
    expect(policy).toContain(`@${input.platformRef}`);
    expect(policy).toContain("checks: read");
    expect(policy).toContain(input.paperclip.appSlug);
    expect(policy).not.toContain("__FLAMA_");
    const final = await readFile(join(outputRoot, ".github/workflows/flama-final.yml"), "utf8");
    expect(final).toContain("pull_request:");
    expect(final).not.toContain("push:");
    const dependabot = parseYaml(
      await readFile(join(outputRoot, ".github/dependabot.yml"), "utf8"),
    ) as { updates: Array<Record<string, unknown>> };
    expect(dependabot.updates.map((entry) => entry["package-ecosystem"])).toEqual([
      "github-actions",
      "npm",
    ]);
    expect(dependabot.updates.every((entry) => entry["target-branch"] === "main")).toBe(true);
    expect(JSON.parse(await readFile(join(outputRoot, ".flama/platform-lock.json"), "utf8"))).toEqual({
      schemaVersion: 1,
      repository: "maxbec/flama-delivery-platform",
      version: input.platformVersion,
      ref: input.platformRef,
    });
    expect(JSON.parse(await readFile(join(outputRoot, ".release-please-config.json"), "utf8"))).toEqual({
      packages: { ".": { "release-type": "node", "include-component-in-tag": false } },
    });
    expect(JSON.parse(await readFile(join(outputRoot, ".release-please-manifest.json"), "utf8"))).toEqual({
      ".": "1.2.3",
    });
    await expect(access(join(outputRoot, "scripts", "delivery"))).rejects.toThrow();
    await expect(access(join(outputRoot, ".flama", "commands.json"))).rejects.toThrow();

    const rerendered = await renderTemplates({ repositoryRoot, outputRoot, input, dryRun: false });
    expect(rerendered.files.every(({ status }) => status === "unchanged")).toBe(true);
  });

  it("targets Major dependency updates at dev and omits release files when releases are disabled", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "flama-render-major-"));
    const majorInput: RenderInput = {
      ...input,
      profile: "major",
      release: { ...input.release, enabled: false },
    };
    const rendered = await renderTemplates({
      repositoryRoot,
      outputRoot,
      input: majorInput,
      dryRun: false,
    });

    expect(rendered.files).toHaveLength(8);
    const dependabot = parseYaml(
      await readFile(join(outputRoot, ".github/dependabot.yml"), "utf8"),
    ) as { updates: Array<Record<string, unknown>> };
    expect(dependabot.updates.every((entry) => entry["target-branch"] === "dev")).toBe(true);
    await expect(access(join(outputRoot, ".release-please-config.json"))).rejects.toThrow();
    await expect(access(join(outputRoot, ".release-please-manifest.json"))).rejects.toThrow();
  });

  it("preserves repository-owned files and fails atomically on generated-file drift", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "flama-render-conflict-"));
    await mkdir(join(outputRoot, "scripts"), { recursive: true });
    const ownedPath = join(outputRoot, "scripts/delivery");
    await writeFile(ownedPath, "#!/usr/bin/env bash\necho user-owned\n", { mode: 0o755 });
    await renderTemplates({ repositoryRoot, outputRoot, input, dryRun: false });
    await expect(readFile(ownedPath, "utf8")).resolves.toContain("user-owned");

    const generatedPath = join(outputRoot, ".github/workflows/flama-policy.yml");
    await writeFile(generatedPath, "user-edited generated workflow\n", "utf8");

    await expect(
      renderTemplates({ repositoryRoot, outputRoot, input, dryRun: false }),
    ).rejects.toEqual(new RenderConflictError([".github/workflows/flama-policy.yml"]));
    await expect(readFile(generatedPath, "utf8")).resolves.toContain("user-edited");
    await expect(readFile(ownedPath, "utf8")).resolves.toContain("user-owned");
  });
});
