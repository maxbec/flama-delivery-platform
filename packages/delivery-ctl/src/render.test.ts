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

    expect(dryRun.files).toHaveLength(11);
    expect(dryRun.files.every(({ status }) => status === "planned")).toBe(true);
    await expect(access(join(outputRoot, ".github", "dependabot.yml"))).rejects.toThrow();

    const rendered = await renderTemplates({ repositoryRoot, outputRoot, input, dryRun: false });
    expect(rendered.files.every(({ status }) => status === "created")).toBe(true);
    const policy = await readFile(join(outputRoot, ".github/workflows/flama-policy.yml"), "utf8");
    expect(policy).toContain(`@${input.platformRef}`);
    expect(policy).toContain("checks: read");
    expect(policy).toContain(input.paperclip.appSlug);
    expect(policy).not.toContain("__FLAMA_");
    // A green change should land without anyone pressing the button; only a
    // release stays a person's call.
    const autoMerge = await readFile(join(outputRoot, ".github/workflows/flama-auto-merge.yml"), "utf8");
    expect(autoMerge).toContain(`@${input.platformRef}`);
    expect(autoMerge).toContain("profile: fast");
    expect(autoMerge).toContain("release-branch: main");
    expect(autoMerge).not.toContain("__FLAMA_");
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
    // The release manifest reports `preserved`: seeded once, then owned by
    // release-please, so it is not compared against generated content.
    expect(
      rerendered.files.every(({ path, status }) =>
        [".release-please-manifest.json", ".release-please-config.json"].includes(path)
          ? status === "preserved"
          : status === "unchanged",
      ),
    ).toBe(true);
  });

  /*
   * The manifest records what the repository has actually published, including
   * prereleases the render input cannot express — its `currentVersion` must
   * match X.Y.Z. Regenerating it rewrote a consumer sitting on 3.3.0-beta back
   * to 3.3.0, handing release-please a version that repository had already
   * released. It is seeded once and then belongs to release-please.
   */
  it("seeds the release manifest once and never rewrites it afterwards", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "flama-render-manifest-"));
    await renderTemplates({ repositoryRoot, outputRoot, input, dryRun: false });

    const manifestPath = join(outputRoot, ".release-please-manifest.json");
    // What release-please would have written after shipping a prerelease.
    await writeFile(manifestPath, `${JSON.stringify({ ".": "3.3.0-beta" }, null, 2)}\n`, "utf8");

    const rerun = await renderTemplates({ repositoryRoot, outputRoot, input, dryRun: false });

    expect(rerun.files).toContainEqual({ path: ".release-please-manifest.json", status: "preserved" });
    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toEqual({ ".": "3.3.0-beta" });
  });

  /*
   * Release notes are a product decision. One consumer had tuned
   * changelog-sections and bootstrap-sha in this file; regenerating it would
   * have replaced all of that with the default and silently undone the thing
   * those releases were configured to produce.
   */
  it("seeds the release config once and keeps consumer tuning afterwards", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "flama-render-config-"));
    await renderTemplates({ repositoryRoot, outputRoot, input, dryRun: false });

    const configPath = join(outputRoot, ".release-please-config.json");
    const tuned = {
      "bootstrap-sha": "0".repeat(40),
      "changelog-sections": [{ type: "feat", section: "✨ Features", hidden: false }],
      packages: { ".": { "release-type": "node" } },
    };
    await writeFile(configPath, `${JSON.stringify(tuned, null, 2)}\n`, "utf8");

    const rerun = await renderTemplates({ repositoryRoot, outputRoot, input, dryRun: false });

    expect(rerun.files).toContainEqual({ path: ".release-please-config.json", status: "preserved" });
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(tuned);
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

    expect(rendered.files).toHaveLength(9);
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

describe("push guard", () => {
  it("renders only where the plan refuses branch protection", async () => {
    // Every repository would otherwise carry a workflow that runs on every push
    // to report something branch protection already prevents.
    const outputRoot = await mkdtemp(join(tmpdir(), "flama-guard-off-"));
    const without = await renderTemplates({ repositoryRoot, outputRoot, input, dryRun: true });
    expect(without.files.map(({ path }) => path))
      .not.toContain(".github/workflows/flama-push-guard.yml");

    const guardedRoot = await mkdtemp(join(tmpdir(), "flama-guard-on-"));
    const guarded = await renderTemplates({
      repositoryRoot,
      outputRoot: guardedRoot,
      input: { ...input, substituteControls: { pushGuard: true } },
      dryRun: false,
    });
    expect(guarded.files.map(({ path }) => path))
      .toContain(".github/workflows/flama-push-guard.yml");

    const workflow = parseYaml(
      await readFile(join(guardedRoot, ".github", "workflows", "flama-push-guard.yml"), "utf8"),
    ) as { on: { push: { branches: string[] } }; jobs: Record<string, { with: Record<string, string> }> };
    expect(workflow.on.push.branches).toEqual(["main"]);
    expect(workflow.jobs["push-guard"]?.with["app-slug"]).toBe(input.paperclip.appSlug);
  });
});

describe("merge gate", () => {
  it("renders only where the plan refuses branch protection, and tells auto-merge", async () => {
    // Where GitHub holds the merge itself, a second thing holding it would
    // merge past the very rule it is standing in for.
    const offRoot = await mkdtemp(join(tmpdir(), "flama-merge-gate-off-"));
    const off = await renderTemplates({
      repositoryRoot,
      outputRoot: offRoot,
      input,
      dryRun: false,
    });
    expect(off.files.map(({ path }) => path))
      .not.toContain(".github/workflows/flama-merge-gate.yml");
    expect(
      await readFile(join(offRoot, ".github", "workflows", "flama-auto-merge.yml"), "utf8"),
    ).toContain("merge-gate: false");

    const onRoot = await mkdtemp(join(tmpdir(), "flama-merge-gate-on-"));
    const on = await renderTemplates({
      repositoryRoot,
      outputRoot: onRoot,
      input: { ...input, substituteControls: { pushGuard: true, mergeGate: true } },
      dryRun: false,
    });
    expect(on.files.map(({ path }) => path))
      .toContain(".github/workflows/flama-merge-gate.yml");

    const workflow = parseYaml(
      await readFile(join(onRoot, ".github", "workflows", "flama-merge-gate.yml"), "utf8"),
    ) as {
      on: Record<string, { types: string[] }>;
      jobs: Record<string, { with: Record<string, string> }>;
    };
    // Both events, because neither alone sees every check: the preflight is a
    // standalone App check run, the gates are workflow runs.
    expect(Object.keys(workflow.on).sort()).toEqual(["check_run", "workflow_run"]);
    expect(workflow.jobs["merge-gate"]?.with["paperclip-app-slug"]).toBe(input.paperclip.appSlug);
    expect(workflow.jobs["merge-gate"]?.with["base-branch"]).toBe("main");
    // It listens to every finished workflow and check run, its own included.
    const guard = (workflow.jobs["merge-gate"] as unknown as { if: string }).if;
    expect(guard).toContain("github.event.workflow_run.name != 'Flama Merge Gate'");
    expect(guard).toContain("!contains(github.event.check_run.name, 'Flama Merge Gate')");

    // Auto-merge must stand down, or it fails closed on a repository this gate
    // is already covering.
    expect(
      await readFile(join(onRoot, ".github", "workflows", "flama-auto-merge.yml"), "utf8"),
    ).toContain("merge-gate: true");
  });
});
