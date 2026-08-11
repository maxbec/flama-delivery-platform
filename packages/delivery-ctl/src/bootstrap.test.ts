import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  bootstrapRepository,
  BootstrapError,
  type BootstrapInput,
} from "./bootstrap.js";

const execute = promisify(execFile);
const platformRoot = new URL("../../../", import.meta.url).pathname;

async function git(root: string, ...args: readonly string[]): Promise<string> {
  const result = await execute("git", ["-C", root, ...args], { encoding: "utf8" });
  return result.stdout.trim();
}

async function initializeRepository(
  existingDeliveryScript = false,
  options: { agents?: boolean } = {},
): Promise<{ root: string; sha: string }> {
  const root = await mkdtemp(join(tmpdir(), "flama-bootstrap-"));
  await git(root, "init", "--initial-branch=main");
  await git(root, "config", "user.name", "Bootstrap Test");
  await git(root, "config", "user.email", "bootstrap@example.invalid");
  await git(root, "remote", "add", "origin", "https://github.com/maxbec/example.git");
  await writeFile(join(root, "README.md"), "# Existing repository\n", "utf8");
  if (options.agents !== false) {
    await writeFile(join(root, "AGENTS.md"), "# Existing instructions\n\nKeep this text.\n", "utf8");
  }
  if (existingDeliveryScript) {
    await mkdir(join(root, "scripts"), { recursive: true });
    await writeFile(join(root, "scripts/delivery"), "#!/usr/bin/env bash\necho repository-owned\n", {
      mode: 0o755,
    });
  }
  await git(root, "add", ".");
  await git(root, "commit", "-m", "initial");
  const sha = await git(root, "rev-parse", "HEAD");
  await git(root, "update-ref", "refs/remotes/origin/main", sha);
  return { root, sha };
}

function bootstrapInput(baseSha: string): BootstrapInput {
  const commands = {
    buildable: ["pnpm", "run", "build"],
    affected: ["pnpm", "test"],
    full: ["pnpm", "test"],
    smoke: ["pnpm", "run", "smoke"],
    health: ["pnpm", "run", "health"],
  } as const;
  return {
    schemaVersion: 1,
    repository: {
      nameWithOwner: "maxbec/example",
      disposition: "in_scope",
      mutationAllowed: true,
      isFork: false,
      isArchived: false,
    },
    baseSha,
    sourceBranch: "main",
    contract: {
      schemaVersion: 1,
      repository: { owner: "maxbec", name: "example", visibility: "public" },
      paperclip: {
        company: "Private",
        projectId: "project-example",
        workspaceId: "workspace-example",
      },
      profile: "fast",
      branches: { default: "main", stable: "main", featureTarget: "main" },
      commands: {
        buildable: "./scripts/delivery buildable",
        affected: "./scripts/delivery affected",
        full: "./scripts/delivery full",
        smoke: "./scripts/delivery smoke",
        health: "./scripts/delivery health",
      },
      changeDetection: {
        failClosed: true,
        broadenOn: [
          "shared_packages",
          "lockfiles",
          "ci_build_tooling",
          "authentication",
          "database_schema",
          "breaking_change",
          "uncertain_detection",
        ],
      },
      release: {
        enabled: true,
        strategy: "release-please",
        impactSource: "paperclip_task",
        type: "node",
      },
      deployment: {
        deployable: false,
        provider: "none",
        manifestPath: ".deploy/production.yaml",
      },
      secrets: {
        source: "infisical",
        projectSlug: "example-project",
        paths: { development: "/development" },
        exceptionsFile: ".flama/secret-exceptions.json",
      },
      platform: {
        repository: "maxbec/flama-delivery-platform",
        version: "0.1.0",
      },
    },
    render: {
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
      commands,
    },
  };
}

describe("repository bootstrap", () => {
  it("accepts the Edilio company's actual GitHub owner", async () => {
    // The Edilio company's owner is the organization edilio-app. The
    // identically named personal account belongs to someone else.
    const repository = await initializeRepository();
    await git(repository.root, "remote", "set-url", "origin",
      "https://github.com/edilio-app/edilio.git");
    const base = bootstrapInput(repository.sha);
    const edilio = {
      ...base,
      repository: { ...base.repository, nameWithOwner: "edilio-app/edilio" },
      contract: {
        ...base.contract,
        repository: { ...base.contract.repository, owner: "edilio-app", name: "edilio" },
        paperclip: { ...base.contract.paperclip, company: "Edilio" as const },
      },
      render: {
        ...base.render,
        repository: "edilio-app/edilio",
        paperclip: { ...base.render.paperclip, company: "Edilio" as const },
      },
    } as unknown as BootstrapInput;

    await expect(bootstrapRepository({
      repositoryRoot: platformRoot,
      outputRoot: repository.root,
      input: edilio,
      dryRun: true,
    })).resolves.toMatchObject({ status: "planned" });
  });

  it("dry-runs, prepares from the exact remote source, and reruns idempotently", async () => {
    const repository = await initializeRepository();
    const input = bootstrapInput(repository.sha);

    const planned = await bootstrapRepository({
      repositoryRoot: platformRoot,
      outputRoot: repository.root,
      input,
      dryRun: true,
    });
    expect(planned.status).toBe("planned");
    expect(planned.generated.files).toHaveLength(11);
    expect(planned.generated.files.every(({ status }) => status === "planned")).toBe(true);
    expect(planned.repositoryOwned).toContainEqual({ path: "AGENTS.md", status: "append_planned" });
    await expect(access(join(repository.root, ".flama/platform-lock.json"))).rejects.toThrow();

    const prepared = await bootstrapRepository({
      repositoryRoot: platformRoot,
      outputRoot: repository.root,
      input,
      dryRun: false,
    });
    expect(prepared.status).toBe("prepared");
    expect(prepared.generated.files.every(({ status }) => status === "created")).toBe(true);
    expect(prepared.repositoryOwned).toContainEqual({ path: "scripts/delivery", status: "created" });
    expect(prepared.repositoryOwned).toContainEqual({ path: "AGENTS.md", status: "appended" });

    // Generated files are platform-owned and drift-protected. A consumer
    // formatter that rewrites them would fight the platform on every run, so
    // the repository is told to leave them alone.
    expect(prepared.repositoryOwned.map(({ path }) => path)).toContain(".prettierignore");
    const ignore = await readFile(join(repository.root, ".prettierignore"), "utf8");
    expect(ignore).toContain(".flama/");
    expect(ignore).toContain(".github/workflows/flama-");
    // Every generated and scaffolded path, not just the .flama directory.
    for (const path of [".paperclip/", ".github/CODEOWNERS", "scripts/delivery"]) {
      expect(ignore).toContain(path);
    }
    const agents = await readFile(join(repository.root, "AGENTS.md"), "utf8");
    expect(agents).toContain("Keep this text.");
    expect(agents.match(/<!-- flama-delivery:start -->/gu)).toHaveLength(1);
    expect(JSON.stringify(prepared)).not.toContain("maxbec/example");
    expect(JSON.stringify(prepared)).not.toContain("project-example");

    await git(repository.root, "add", ".");
    await git(repository.root, "commit", "-m", "bootstrap");
    const updatedSha = await git(repository.root, "rev-parse", "HEAD");
    await git(repository.root, "update-ref", "refs/remotes/origin/main", updatedSha);
    const rerun = await bootstrapRepository({
      repositoryRoot: platformRoot,
      outputRoot: repository.root,
      input: bootstrapInput(updatedSha),
      dryRun: false,
    });
    expect(rerun.generated.files.every(({ status }) => status === "unchanged")).toBe(true);
    expect(rerun.repositoryOwned.every(({ status }) => status === "preserved")).toBe(true);
    expect((await readFile(join(repository.root, "AGENTS.md"), "utf8")).match(/<!-- flama-delivery:start -->/gu)).toHaveLength(1);
  });

  it("never overwrites an existing repository-owned delivery entrypoint", async () => {
    const repository = await initializeRepository(true);
    const result = await bootstrapRepository({
      repositoryRoot: platformRoot,
      outputRoot: repository.root,
      input: bootstrapInput(repository.sha),
      dryRun: false,
    });

    expect(result.repositoryOwned).toContainEqual({ path: "scripts/delivery", status: "preserved" });
    await expect(readFile(join(repository.root, "scripts/delivery"), "utf8")).resolves.toContain(
      "repository-owned",
    );
  });

  it("fails closed when the checkout is not at the recorded remote source SHA", async () => {
    const repository = await initializeRepository();
    await writeFile(join(repository.root, "untracked.txt"), "local change\n", "utf8");

    await expect(
      bootstrapRepository({
        repositoryRoot: platformRoot,
        outputRoot: repository.root,
        input: bootstrapInput(repository.sha),
        dryRun: true,
      }),
    ).rejects.toEqual(new BootstrapError("bootstrap_dirty_worktree"));
  });

  it("denies fork state at runtime before inspecting or writing a checkout", async () => {
    const repository = await initializeRepository();
    const input = bootstrapInput(repository.sha);
    const forkInput = {
      ...input,
      repository: { ...input.repository, mutationAllowed: false, isFork: true },
    } as unknown as BootstrapInput;

    await expect(
      bootstrapRepository({
        repositoryRoot: platformRoot,
        outputRoot: repository.root,
        input: forkInput,
        dryRun: false,
      }),
    ).rejects.toEqual(new BootstrapError("bootstrap_scope_denied"));
    await expect(access(join(repository.root, ".flama/platform-lock.json"))).rejects.toThrow();
  });

  it("writes the formatter exclusion where the repository actually keeps it", async () => {
    const repository = await initializeRepository();
    // Trunk-managed repositories keep the prettier ignore list beside their
    // other linter configuration; a root-level file is never read there.
    await mkdir(join(repository.root, "configs"), { recursive: true });
    await writeFile(join(repository.root, "configs/.prettierignore"), "dist\n", "utf8");
    await git(repository.root, "add", "configs/.prettierignore");
    await git(repository.root, "commit", "-m", "add prettier ignore");
    const sha = await git(repository.root, "rev-parse", "HEAD");
    await git(repository.root, "update-ref", "refs/remotes/origin/main", sha);

    const prepared = await bootstrapRepository({
      repositoryRoot: platformRoot,
      outputRoot: repository.root,
      input: bootstrapInput(sha),
      dryRun: false,
    });

    expect(prepared.repositoryOwned.map(({ path }) => path)).toContain("configs/.prettierignore");
    expect(prepared.repositoryOwned.map(({ path }) => path)).not.toContain(".prettierignore");
    // The exclusions have to actually reach the file the formatter reads.
    const ignore = await readFile(join(repository.root, "configs/.prettierignore"), "utf8");
    expect(ignore).toContain("dist");
    expect(ignore).toContain(".flama/");
  });

  it("expresses the exclusion in Trunk's own lint configuration", async () => {
    const repository = await initializeRepository();
    await mkdir(join(repository.root, ".trunk"), { recursive: true });
    await writeFile(join(repository.root, ".trunk/trunk.yaml"),
      "version: 0.1\nlint:\n  ignore:\n    - linters: [prettier]\n      paths: [CHANGELOG.md]\n", "utf8");
    await git(repository.root, "add", ".trunk/trunk.yaml");
    await git(repository.root, "commit", "-m", "add trunk config");
    const sha = await git(repository.root, "rev-parse", "HEAD");
    await git(repository.root, "update-ref", "refs/remotes/origin/main", sha);

    const prepared = await bootstrapRepository({
      repositoryRoot: platformRoot,
      outputRoot: repository.root,
      input: bootstrapInput(sha),
      dryRun: false,
    });

    expect(prepared.repositoryOwned.map(({ path }) => path)).toContain(".trunk/trunk.yaml");
    const trunk = parseYaml(await readFile(join(repository.root, ".trunk/trunk.yaml"), "utf8"));
    // The repository keeps its own ignores and gains ours.
    expect(trunk.lint.ignore).toHaveLength(2);
    expect(JSON.stringify(trunk.lint.ignore)).toContain("CHANGELOG.md");
    expect(JSON.stringify(trunk.lint.ignore)).toContain(".flama/**");
  });

  it("preserves the repository's own comments and document marker", async () => {
    // The file belongs to the repository. Parsing and re-stringifying it drops
    // every comment and the --- marker, which is a destructive edit to content
    // nobody asked us to touch, and yamllint fails the result.
    const repository = await initializeRepository();
    const original = [
      "---",
      "# This file controls the behavior of Trunk",
      "version: 0.1",
      "",
      "# Trunk provides extensibility via plugins.",
      "plugins:",
      "  sources:",
      "    - id: trunk",
      "      ref: v1.10.2",
      "",
      "lint:",
      "  ignore:",
      "    - linters: [prettier]",
      "      paths: [CHANGELOG.md]",
      "",
    ].join("\n");
    await mkdir(join(repository.root, ".trunk"), { recursive: true });
    await writeFile(join(repository.root, ".trunk/trunk.yaml"), original, "utf8");
    await git(repository.root, "add", ".trunk/trunk.yaml");
    await git(repository.root, "commit", "-m", "add trunk config");
    const sha = await git(repository.root, "rev-parse", "HEAD");
    await git(repository.root, "update-ref", "refs/remotes/origin/main", sha);

    await bootstrapRepository({
      repositoryRoot: platformRoot,
      outputRoot: repository.root,
      input: bootstrapInput(sha),
      dryRun: false,
    });

    const merged = await readFile(join(repository.root, ".trunk/trunk.yaml"), "utf8");
    expect(merged.startsWith("---\n")).toBe(true);
    expect(merged).toContain("# This file controls the behavior of Trunk");
    expect(merged).toContain("# Trunk provides extensibility via plugins.");
    const trunk = parseYaml(merged);
    expect(trunk.lint.ignore).toHaveLength(2);
    expect(JSON.stringify(trunk.lint.ignore)).toContain(".flama/**");
    // Generated files must be invisible to every linter, not an enumerated few:
    // a generated .mjs was being linted by eslint because eslint was not listed.
    const ours = trunk.lint.ignore.find((entry: { paths: string[] }) =>
      entry.paths.includes(".flama/**"));
    expect(ours.linters).toEqual(["ALL"]);
  });
});

describe("generated agent instructions", () => {
  it("creates AGENTS.md with a top-level heading and adds none when appending", async () => {
    // markdownlint MD041 fails a file whose first line is not a top-level
    // heading, and MD025 fails a second one — so a created file needs a title
    // and an appended block must not bring its own.
    const created = await initializeRepository(false, { agents: false });
    await bootstrapRepository({
      repositoryRoot: platformRoot,
      outputRoot: created.root,
      input: bootstrapInput(created.sha),
      dryRun: false,
    });
    // The title belongs to AGENTS.md alone; every other created file is untouched.
    const script = await readFile(join(created.root, "scripts/delivery"), "utf8");
    expect(script.startsWith("#!")).toBe(true);
    const fresh = await readFile(join(created.root, "AGENTS.md"), "utf8");
    expect(fresh.split("\n")[0]).toMatch(/^# \S/u);
    expect(fresh.match(/^# /gmu)).toHaveLength(1);
    expect(fresh).toContain("<!-- flama-delivery:start -->");

    const existing = await initializeRepository(false);
    await bootstrapRepository({
      repositoryRoot: platformRoot,
      outputRoot: existing.root,
      input: bootstrapInput(existing.sha),
      dryRun: false,
    });
    const appended = await readFile(join(existing.root, "AGENTS.md"), "utf8");
    expect(appended).toContain("Keep this text.");
    expect(appended.match(/^# /gmu)).toHaveLength(1);

    // A repository whose prettier reflows prose rewrites the generated block on
    // every run, so the block fences itself off rather than fighting the
    // formatter. The rest of the file is still the repository's to format.
    expect(appended).toContain("<!-- prettier-ignore-start -->");
    expect(appended).toContain("<!-- prettier-ignore-end -->");
    expect(appended.indexOf("<!-- prettier-ignore-start -->"))
      .toBeLessThan(appended.indexOf("<!-- flama-delivery:start -->"));
    expect(appended.indexOf("<!-- flama-delivery:end -->"))
      .toBeLessThan(appended.indexOf("<!-- prettier-ignore-end -->"));
  });
});
