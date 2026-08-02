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
    // Dependabot rejects the whole file if the clock time parses as an
    // integer, which an unquoted 04:00 does under YAML 1.1.
    expect(await readFile(join(outputRoot, ".github/dependabot.yml"), "utf8"))
      .toMatch(/time: "04:00"/u);
    for (const entry of dependabot.updates) {
      const schedule = entry["schedule"] as Record<string, unknown>;
      expect(typeof schedule["time"]).toBe("string");
    }
    // A newly published package can be malicious; every ecosystem waits.
    for (const entry of dependabot.updates) {
      expect(entry["cooldown"]).toEqual({ "default-days": 7 });
    }
    // yamllint requires an explicit document start, and consumer repositories
    // run it against generated files.
    expect(await readFile(join(outputRoot, ".github/dependabot.yml"), "utf8")).toMatch(/^---\n/u);
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

  it("replaces a legacy generated file only when that exact path is authorized", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "flama-render-takeover-"));
    await mkdir(join(outputRoot, ".github"), { recursive: true });
    await writeFile(join(outputRoot, ".github/dependabot.yml"), "version: 2\n", "utf8");

    // Unauthorized: the existing file is left alone and the run refuses.
    await expect(renderTemplates({
      repositoryRoot, outputRoot, input, dryRun: false,
    })).rejects.toBeInstanceOf(RenderConflictError);

    const replaced = await renderTemplates({
      repositoryRoot, outputRoot, input, dryRun: false,
      replaceExisting: [".github/dependabot.yml"],
    });

    expect(replaced.files).toContainEqual({ path: ".github/dependabot.yml", status: "replaced" });
    expect(await readFile(join(outputRoot, ".github/dependabot.yml"), "utf8")).toContain("cooldown");
  });

  it("refuses an authorization for a path it does not generate", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "flama-render-takeover-"));

    await expect(renderTemplates({
      repositoryRoot, outputRoot, input, dryRun: false,
      replaceExisting: ["src/index.ts"],
    })).rejects.toThrow();
  });
});

describe("delivery command contract", () => {
  const render = async (commands: RenderInput["commands"]) =>
    renderTemplates({
      repositoryRoot,
      outputRoot: await mkdtemp(join(tmpdir(), "flama-render-")),
      input: { ...input, commands },
      dryRun: true,
    });

  it("refuses a command that cannot fail", async () => {
    // This is the exact contract one canary shipped: every command was
    // `node --version`, so the gate passed on any machine with Node installed.
    for (const command of [
      ["node", "--version"],
      ["python3", "-V"],
      ["true"],
      [":"],
      ["echo", "ok"],
      ["pnpm", "--help"],
    ]) {
      await expect(render({ ...input.commands, buildable: command })).rejects.toThrow(
        /proves nothing/u,
      );
    }
  });

  it("refuses an empty or blank command", async () => {
    await expect(render({ ...input.commands, affected: [] })).rejects.toThrow();
    await expect(render({ ...input.commands, affected: ["   "] })).rejects.toThrow();
  });

  it("accepts a command that can actually fail", async () => {
    const accepted = await render({
      ...input.commands,
      buildable: ["python3", "scripts/config-check.py"],
      affected: ["npm", "run", "test"],
    });
    expect(accepted.files.length).toBeGreaterThan(0);
  });
});

describe("delivery CODEOWNERS", () => {
  it("claims review only for the deployment manifest", async () => {
    // Branch protection requires code-owner review, and the code owner is the
    // same account that opens every migration pull request — so listing the
    // generated files here made the platform's own re-render unmergeable.
    // Those files are already validated against the pinned platform by the
    // Policy Gate on every pull request, which is stronger than a review.
    const outputRoot = await mkdtemp(join(tmpdir(), "flama-render-"));
    await renderTemplates({ repositoryRoot, outputRoot, input, dryRun: false });
    const codeowners = await readFile(join(outputRoot, ".github", "CODEOWNERS"), "utf8");

    expect(codeowners).toContain("/.deploy/production.yaml @maxbec");
    for (const generated of [
      "/.github/workflows/flama-*.yml",
      "/.flama/platform-lock.json",
      "/.github/dependabot.yml",
      "/.release-please-manifest.json",
    ]) {
      expect(codeowners).not.toContain(`${generated} @`);
    }
  });
});
