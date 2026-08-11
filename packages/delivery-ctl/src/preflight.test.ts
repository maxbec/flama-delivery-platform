import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createSchemaValidator } from "../../contracts/src/schema-validator.js";
import { runPreflight, type PreflightRunInput } from "./preflight.js";

const temporaryDirectories: string[] = [];
const platformRoot = fileURLToPath(new URL("../../../", import.meta.url));

async function repositoryWithDeliveryScript(failAffected = false): Promise<{ root: string; headSha: string }> {
  const root = await mkdtemp(join(tmpdir(), "flama-preflight-test-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "scripts"));
  await writeFile(
    join(root, "scripts", "delivery"),
    `#!/usr/bin/env node\nprocess.stdout.write("sensitive-child-output");\nprocess.exit(${failAffected ? "process.argv[2] === 'affected' ? 1 : 0" : "0"});\n`,
    "utf8",
  );
  await chmod(join(root, "scripts", "delivery"), 0o755);
  const git = (args: readonly string[]) => spawnSync("git", [...args], { cwd: root, encoding: "utf8" });
  expect(git(["init", "-q"]).status).toBe(0);
  expect(git(["add", "scripts/delivery"]).status).toBe(0);
  expect(git(["-c", "commit.gpgsign=false", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"]).status).toBe(0);
  const headSha = git(["rev-parse", "HEAD"]).stdout.trim();
  return { root, headSha };
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

describe("deterministic preflight", () => {
  it("runs only the fixed commands and retains digest-only output evidence", async () => {
    const { root, headSha } = await repositoryWithDeliveryScript();
    const input: PreflightRunInput = {
      schemaVersion: 1,
      repository: "maxbec/example",
      headSha,
      baseSha: headSha,
      releaseImpact: "patch",
    };

    const result = await runPreflight(input, root);

    expect(result.status).toBe("passed");
    expect(result.commands.map(({ command }) => command)).toEqual([
      "./scripts/delivery buildable",
      "./scripts/delivery affected",
    ]);
    expect(result.commands.every(({ evidenceDigest }) => /^sha256:[0-9a-f]{64}$/u.test(evidenceDigest))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("sensitive-child-output");
    const repeated = await runPreflight(input, root);
    expect(repeated.commands.map(({ evidenceDigest }) => evidenceDigest)).toEqual(
      result.commands.map(({ evidenceDigest }) => evidenceDigest),
    );
    const validator = await createSchemaValidator(platformRoot);
    expect(validator.validate("preflight-run-result", result)).toEqual({
      ok: true,
      schema: "preflight-run-result",
    });
  });

  it("stops after a deterministic failure without retrying it", async () => {
    const { root, headSha } = await repositoryWithDeliveryScript(true);
    const result = await runPreflight({
      schemaVersion: 1,
      repository: "edilio-app/example",
      headSha,
      baseSha: headSha,
      releaseImpact: "none",
    }, root);

    expect(result.status).toBe("failed");
    expect(result.commands).toHaveLength(2);
    expect(result.commands[1]).toMatchObject({ command: "./scripts/delivery affected", status: "failed", exitCode: 1 });
  });

  /*
   * The ceiling is sized for a CI job. The sweep runs inside a much shorter
   * window, and a command that ignores the caller's ceiling holds the pass
   * until its own — which is how one repository installing dependencies from
   * cold ran the controller past its run timeout.
   */
  it("stops a delivery command at the caller's ceiling and fails the run", async () => {
    const root = await mkdtemp(join(tmpdir(), "flama-preflight-timeout-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "scripts"));
    // Ignores SIGTERM's default disposition only insofar as it never exits on
    // its own: the run must end because the ceiling ended it.
    await writeFile(
      join(root, "scripts", "delivery"),
      "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n",
      "utf8",
    );
    await chmod(join(root, "scripts", "delivery"), 0o755);
    const git = (args: readonly string[]) => spawnSync("git", [...args], { cwd: root, encoding: "utf8" });
    git(["init", "-q"]);
    git(["add", "scripts/delivery"]);
    git(["-c", "commit.gpgsign=false", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"]);
    const headSha = git(["rev-parse", "HEAD"]).stdout.trim();

    const result = await runPreflight(
      { schemaVersion: 1, repository: "maxbec/example", headSha, baseSha: headSha, releaseImpact: "none" },
      root,
      { commandTimeoutMilliseconds: 250 },
    );

    // Killed, so unfinished, so failed — an unfinished command has shown
    // nothing, and `affected` is never reached.
    expect(result.status).toBe("failed");
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]).toMatchObject({ command: "./scripts/delivery buildable", status: "failed" });
  });

  /*
   * The evidence hashes are finalised when the run settles. A killed command's
   * pipes drain afterwards, so a late chunk used to reach an already-digested
   * hash and throw ERR_CRYPTO_HASH_FINALIZED out of an event handler — which
   * is an uncatchable crash of the controller process, not a failed preflight.
   * That is how the first pass on 0.3.3 died.
   */
  it("survives output that arrives after the command was killed", async () => {
    const root = await mkdtemp(join(tmpdir(), "flama-preflight-late-output-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "scripts"));
    // Keeps writing through SIGTERM, so output is still in flight when the
    // ceiling settles the run, and a grandchild holds the pipe open after the
    // child itself is gone.
    await writeFile(
      join(root, "scripts", "delivery"),
      [
        "#!/usr/bin/env node",
        "const { spawn } = require('node:child_process');",
        "spawn(process.execPath, ['-e', \"setInterval(() => process.stdout.write('x'.repeat(1024)), 5)\"],",
        "  { stdio: ['ignore', 'inherit', 'inherit'], detached: true }).unref();",
        "process.on('SIGTERM', () => {});",
        "setInterval(() => process.stdout.write('late'), 5);",
      ].join("\n"),
      "utf8",
    );
    await chmod(join(root, "scripts", "delivery"), 0o755);
    const git = (args: readonly string[]) => spawnSync("git", [...args], { cwd: root, encoding: "utf8" });
    git(["init", "-q"]);
    git(["add", "scripts/delivery"]);
    git(["-c", "commit.gpgsign=false", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"]);
    const headSha = git(["rev-parse", "HEAD"]).stdout.trim();

    const result = await runPreflight(
      { schemaVersion: 1, repository: "maxbec/example", headSha, baseSha: headSha, releaseImpact: "none" },
      root,
      { commandTimeoutMilliseconds: 250 },
    );

    // Returning at all is the assertion: the crash took the process down.
    expect(result.status).toBe("failed");
    expect(result.commands[0]?.evidenceDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    // Settling waits for the pipes rather than reading mid-flight, but never
    // longer than the drain grace, since the grandchild holds them open.
    expect(result.commands[0]?.durationMilliseconds).toBeLessThan(20_000);
  }, 30_000);

  it("rejects a dirty or SHA-mismatched worktree before executing", async () => {
    const { root, headSha } = await repositoryWithDeliveryScript();
    await writeFile(join(root, "untracked.txt"), "dirty", "utf8");

    await expect(runPreflight({
      schemaVersion: 1,
      repository: "navigaite/example",
      headSha,
      baseSha: headSha,
      releaseImpact: "minor",
    }, root)).rejects.toMatchObject({ code: "worktree_not_clean" });
    expect(await readFile(join(root, "untracked.txt"), "utf8")).toBe("dirty");
  });
});
