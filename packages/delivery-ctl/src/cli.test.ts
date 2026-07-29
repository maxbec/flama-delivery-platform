import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCli, type CliIo } from "./cli.js";

class MemoryIo implements CliIo {
  stdout = "";
  stderr = "";

  writeStdout(value: string): void {
    this.stdout += value;
  }

  writeStderr(value: string): void {
    this.stderr += value;
  }
}

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const contractPath = fileURLToPath(
  new URL("../../contracts/test/fixtures/delivery-contract.valid.json", import.meta.url),
);
const manifestPath = fileURLToPath(
  new URL("../../contracts/test/fixtures/deployment-manifest.valid.yaml", import.meta.url),
);
const preflightInputPath = fileURLToPath(
  new URL("../../contracts/test/fixtures/preflight-run-input.valid.json", import.meta.url),
);
const inventoryPath = fileURLToPath(
  new URL("../../contracts/test/fixtures/repository-inventory.valid.json", import.meta.url),
);
const renderInputPath = fileURLToPath(new URL("../../../tests/fixtures/render/fast.json", import.meta.url));
const publishCheckInputPath = fileURLToPath(
  new URL("../../../tests/fixtures/publish-check/valid.json", import.meta.url),
);
const releaseEvidenceInputPath = fileURLToPath(
  new URL("../../../tests/fixtures/release-evidence/valid.json", import.meta.url),
);
const promotionInputPath = fileURLToPath(
  new URL("../../../tests/fixtures/promote/valid.json", import.meta.url),
);
const paperclipFoundationInputPath = fileURLToPath(
  new URL("../../../tests/fixtures/paperclip-foundation/valid.json", import.meta.url),
);
const paperclipControllersInputPath = fileURLToPath(
  new URL("../../../tests/fixtures/paperclip-controllers/valid.json", import.meta.url),
);

describe("delivery CLI", () => {
  it("returns versioned JSON validation output", async () => {
    const io = new MemoryIo();
    const exitCode = await runCli(
      ["validate", "--schema", "delivery-contract", "--input", contractPath],
      io,
      repositoryRoot,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(io.stdout)).toEqual({
      command: "validate",
      dryRun: false,
      ok: true,
      schema: "delivery-contract",
      toolVersion: "0.1.0",
    });
    expect(io.stderr).toBe("");
  });

  it("reports unsupported commands without reflecting arguments", async () => {
    const io = new MemoryIo();
    const sensitiveArgument = "super-secret-argument";

    const exitCode = await runCli(["unknown", sensitiveArgument], io, repositoryRoot);

    expect(exitCode).toBe(2);
    expect(JSON.parse(io.stderr)).toEqual({
      error: { code: "unsupported_command" },
      ok: false,
      toolVersion: "0.1.0",
    });
    expect(io.stderr).not.toContain(sensitiveArgument);
  });

  it("strictly validates the production YAML manifest boundary", async () => {
    const io = new MemoryIo();
    const exitCode = await runCli(
      ["validate", "--schema", "deployment-manifest", "--format", "yaml", "--input", manifestPath],
      io,
      repositoryRoot,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(io.stdout)).toMatchObject({
      command: "validate",
      ok: true,
      schema: "deployment-manifest",
    });
  });

  it("dry-runs deployment without loading an adapter or writing evidence", async () => {
    const io = new MemoryIo();
    const exitCode = await runCli(
      [
        "deploy",
        "--dry-run",
        "--format",
        "yaml",
        "--input",
        manifestPath,
        "--adapter",
        "missing-provider.mjs",
      ],
      io,
      repositoryRoot,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(io.stdout)).toMatchObject({
      command: "deploy",
      dryRun: true,
      ok: true,
      result: {
        status: "planned",
        provider: "docker-compose",
        soakSeconds: 600,
        rollbackAttemptLimit: 1,
      },
    });
  });

  it("dry-runs the fixed preflight plan without executing consumer commands", async () => {
    const io = new MemoryIo();
    const exitCode = await runCli(
      ["preflight", "--dry-run", "--input", preflightInputPath],
      io,
      repositoryRoot,
      "/path/that/does/not/exist",
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(io.stdout)).toMatchObject({
      command: "preflight",
      dryRun: true,
      ok: true,
      result: {
        status: "planned",
        headSha: "a".repeat(40),
        commands: ["./scripts/delivery buildable", "./scripts/delivery affected"],
      },
    });
    expect(io.stderr).toBe("");
  });

  it("audits inventory without emitting repository names", async () => {
    const io = new MemoryIo();
    const exitCode = await runCli(["inventory", "--input", inventoryPath], io, repositoryRoot);

    expect(exitCode).toBe(0);
    expect(JSON.parse(io.stdout)).toMatchObject({
      command: "inventory",
      ok: true,
      result: {
        status: "passed",
        summary: { total: 1, inScope: 1, mutationDenied: 0 },
        owners: { maxbec: { countsMatch: true } },
      },
    });
    expect(io.stdout).not.toContain("maxbec/example");
    expect(io.stderr).toBe("");
  });

  it("denies direct render writes outside the scope-checked bootstrap command", async () => {
    const io = new MemoryIo();
    const outputRoot = await mkdtemp(join(tmpdir(), "flama-cli-render-"));
    const exitCode = await runCli(
      ["render", "--input", renderInputPath, "--output", outputRoot],
      io,
      repositoryRoot,
    );

    expect(exitCode).toBe(2);
    expect(JSON.parse(io.stderr)).toEqual({
      error: { code: "bootstrap_required" },
      ok: false,
      toolVersion: "0.1.0",
    });
  });

  it("dry-runs check publication without requesting a publisher credential", async () => {
    const io = new MemoryIo();
    const exitCode = await runCli(
      ["publish-check", "--dry-run", "--input", publishCheckInputPath],
      io,
      repositoryRoot,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(io.stdout)).toMatchObject({
      command: "publish-check",
      dryRun: true,
      ok: true,
      result: {
        status: "planned",
        headSha: "a".repeat(40),
        check: { name: "Paperclip Preflight", conclusion: "success" },
      },
    });
    expect(io.stdout).not.toContain("maxbec/example");
    expect(io.stdout).not.toContain("runner-example");
    expect(io.stderr).toBe("");
  });

  it("dry-runs immutable release verification without accessing credentials or files", async () => {
    const io = new MemoryIo();
    const exitCode = await runCli(
      ["release-evidence", "--dry-run", "--input", releaseEvidenceInputPath],
      io,
      repositoryRoot,
      "/path/that/does/not/exist",
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(io.stdout)).toMatchObject({
      command: "release-evidence",
      dryRun: true,
      ok: true,
      result: {
        status: "planned",
        version: "1.2.3",
        tagName: "v1.2.3",
        requiredFiles: 3,
      },
    });
    expect(io.stdout).not.toContain("maxbec/example");
    expect(io.stdout).not.toContain("release/example");
    expect(io.stderr).toBe("");
  });

  it("dry-runs Major promotion without requesting identity or exposing repository metadata", async () => {
    const io = new MemoryIo();
    const exitCode = await runCli(
      ["promote", "--dry-run", "--input", promotionInputPath],
      io,
      repositoryRoot,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(io.stdout)).toMatchObject({
      command: "promote",
      dryRun: true,
      ok: true,
      result: {
        status: "planned",
        profile: "major",
        promotion: { sourceBranch: "dev", targetBranch: "main", action: "create_or_reuse" },
      },
    });
    expect(io.stdout).not.toContain("maxbec/example");
    expect(io.stdout).not.toContain("flama-maxbec-delivery");
    expect(io.stderr).toBe("");
  });

  it("dry-runs Paperclip lifecycle installation without requesting identity or exposing company IDs", async () => {
    const io = new MemoryIo();
    const exitCode = await runCli(
      ["paperclip-foundation", "--dry-run", "--input", paperclipFoundationInputPath],
      io,
      repositoryRoot,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(io.stdout)).toMatchObject({
      command: "paperclip-foundation",
      dryRun: true,
      ok: true,
      result: {
        status: "planned",
        summary: { planned: 3, created: 0, reused: 0 },
      },
    });
    expect(io.stdout).not.toContain("10000000-0000-4000-8000-000000000001");
    expect(io.stderr).toBe("");
  });

  it("dry-runs paused Paperclip controller provisioning without requesting identity", async () => {
    const io = new MemoryIo();
    const exitCode = await runCli(
      ["paperclip-controllers", "--dry-run", "--input", paperclipControllersInputPath],
      io,
      repositoryRoot,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(io.stdout)).toMatchObject({
      command: "paperclip-controllers",
      dryRun: true,
      ok: true,
      result: {
        status: "planned",
        disposition: "planned",
        initialStatus: "paused",
        budgetMonthlyCents: 0,
      },
    });
    expect(io.stdout).not.toContain("10000000-0000-4000-8000-000000000001");
    expect(io.stdout).not.toContain("/srv/flama-delivery-platform");
    expect(io.stderr).toBe("");
  });
});
