import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { runCli, type CliIo } from "./cli.js";
import packageJson from "../../../package.json" with { type: "json" };

/* Derived, not restated: a pinned literal here went stale on the first
   release and hid that the CLI itself was announcing the wrong version. */
const toolVersion = packageJson.version;

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
const paperclipBindingsInputPath = fileURLToPath(
  new URL("../../../tests/fixtures/paperclip-bindings/valid.json", import.meta.url),
);
const paperclipRoutinesInputPath = fileURLToPath(
  new URL("../../../tests/fixtures/paperclip-routines/valid.json", import.meta.url),
);
const paperclipGithubTransitionRoutineInputPath = fileURLToPath(
  new URL("../../../tests/fixtures/paperclip-github-transition-routine/valid.json", import.meta.url),
);
const reconciliationInputPath = fileURLToPath(
  new URL("../../../tests/fixtures/reconciliation/valid.json", import.meta.url),
);
const githubPolicyInputPath = fileURLToPath(
  new URL("../../../tests/fixtures/github-policy/valid.json", import.meta.url),
);
const canaryInputPath = fileURLToPath(
  new URL("../../../tests/fixtures/canary/valid.json", import.meta.url),
);
const rollbackInputPath = fileURLToPath(
  new URL("../../../tests/fixtures/rollback/valid.json", import.meta.url),
);
const dockerComposeManifestPath = fileURLToPath(
  new URL("../../../tests/fixtures/provider/deployment-manifest.docker-compose.yaml", import.meta.url),
);
const failurePolicyInputPath = fileURLToPath(
  new URL("../../../tests/fixtures/failure-policy/transient.json", import.meta.url),
);
const policyRepairInputPath = fileURLToPath(
  new URL("../../../tests/fixtures/github-policy-repair/mixed.json", import.meta.url),
);
const governanceResultPath = fileURLToPath(
  new URL("../../../tests/fixtures/governance/result.json", import.meta.url),
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
      toolVersion,
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
      toolVersion,
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

  it("dry-runs rollback without loading an adapter or contacting the provider", async () => {
    const io = new MemoryIo();
    const exitCode = await runCli(
      ["rollback", "--dry-run", "--input", rollbackInputPath, "--adapter", "missing-provider.mjs"],
      io,
      repositoryRoot,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(io.stdout)).toMatchObject({
      command: "rollback",
      dryRun: true,
      ok: true,
      result: {
        status: "planned",
        provider: "docker-compose",
        drill: true,
        attempts: 0,
      },
    });
    expect(io.stderr).toBe("");
  });

  it("refuses a rollback whose migration cannot support it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rollback-cli-"));
    try {
      const inputPath = join(directory, "input.json");
      const source = JSON.parse(await readFile(rollbackInputPath, "utf8")) as Record<string, unknown>;
      await writeFile(
        inputPath,
        JSON.stringify({ ...source, migration: { rollbackCompatible: false } }),
        "utf8",
      );
      const io = new MemoryIo();

      const exitCode = await runCli(["rollback", "--dry-run", "--input", inputPath], io, repositoryRoot);

      expect(exitCode).toBe(2);
      expect(io.stdout).toBe("");
      expect(JSON.parse(io.stderr)).toMatchObject({
        ok: false,
        error: { code: "rollback_migration_incompatible" },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a rollback input that omits the incident reference outside a drill", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rollback-cli-"));
    try {
      const inputPath = join(directory, "input.json");
      const source = JSON.parse(await readFile(rollbackInputPath, "utf8")) as Record<string, unknown>;
      await writeFile(
        inputPath,
        JSON.stringify({ ...source, authorization: { drill: false, incidentRef: null } }),
        "utf8",
      );
      const io = new MemoryIo();

      const exitCode = await runCli(["rollback", "--dry-run", "--input", inputPath], io, repositoryRoot);

      expect(exitCode).toBe(1);
      const output = JSON.parse(io.stdout) as { command: string; ok: boolean; errors: unknown[] };
      expect(output.command).toBe("rollback");
      expect(output.ok).toBe(false);
      expect(output.errors.length).toBeGreaterThan(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("accepts a deployment manifest carrying repository-owned provider parameters", async () => {
    const io = new MemoryIo();
    const exitCode = await runCli(
      ["validate", "--schema", "deployment-manifest", "--format", "yaml", "--input", dockerComposeManifestPath],
      io,
      repositoryRoot,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(io.stdout)).toMatchObject({ ok: true, schema: "deployment-manifest" });
  });

  it("selects the builtin adapter when no repository adapter is supplied", async () => {
    const directory = await mkdtemp(join(tmpdir(), "builtin-adapter-"));
    try {
      const io = new MemoryIo();
      const exitCode = await runCli(
        [
          "deploy",
          "--format",
          "yaml",
          "--input",
          dockerComposeManifestPath,
          "--output",
          join(directory, "result.json"),
        ],
        io,
        repositoryRoot,
        directory,
      );

      // The builtin adapter must be reached and fail on its own provider call
      // rather than the command rejecting a missing --adapter argument.
      expect(exitCode).not.toBe(0);
      expect(io.stderr).not.toContain("adapter_required");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses a provider that has no builtin adapter and no repository adapter", async () => {
    const directory = await mkdtemp(join(tmpdir(), "builtin-adapter-"));
    try {
      const inputPath = join(directory, "manifest.json");
      const manifest = parseYaml(await readFile(dockerComposeManifestPath, "utf8")) as {
        provider: { name: string };
      };
      manifest.provider.name = "render";
      await writeFile(inputPath, JSON.stringify(manifest), "utf8");
      const io = new MemoryIo();

      const exitCode = await runCli(
        ["deploy", "--input", inputPath, "--output", join(directory, "result.json")],
        io,
        repositoryRoot,
        directory,
      );

      expect(exitCode).toBe(2);
      expect(JSON.parse(io.stderr)).toMatchObject({
        ok: false,
        error: { code: "adapter_not_implemented" },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("decides a transient failure response reproducibly in dry-run", async () => {
    const io = new MemoryIo();
    const exitCode = await runCli(
      ["failure-policy", "--dry-run", "--input", failurePolicyInputPath],
      io,
      repositoryRoot,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(io.stdout)).toMatchObject({
      command: "failure-policy",
      dryRun: true,
      ok: true,
      result: {
        retry: "allowed",
        retryDelaySeconds: 20,
        followUp: "none",
        incident: "none",
        releasePath: "open",
        notifyOwner: false,
      },
    });
    expect(io.stderr).toBe("");
  });

  it("emits no failure message, path, or log content in its decision", async () => {
    const io = new MemoryIo();

    await runCli(["failure-policy", "--dry-run", "--input", failurePolicyInputPath], io, repositoryRoot);

    const output = JSON.parse(io.stdout) as { result: Record<string, unknown> };
    expect(Object.keys(output.result).sort()).toEqual([
      "followUp",
      "incident",
      "notifyOwner",
      "releasePath",
      "retry",
      "retryDelaySeconds",
      "rotateCredential",
      "schemaVersion",
    ]);
  });

  it("rejects a failure observation that is not schema valid", async () => {
    const directory = await mkdtemp(join(tmpdir(), "failure-policy-"));
    try {
      const inputPath = join(directory, "input.json");
      await writeFile(inputPath, JSON.stringify({ schemaVersion: 1, stage: "final" }), "utf8");
      const io = new MemoryIo();

      const exitCode = await runCli(["failure-policy", "--dry-run", "--input", inputPath], io, repositoryRoot);

      expect(exitCode).toBe(1);
      expect(JSON.parse(io.stdout)).toMatchObject({ command: "failure-policy", ok: false });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("plans safe repairs and remediation cases separately", async () => {
    const io = new MemoryIo();
    const exitCode = await runCli(
      ["github-policy-repair", "--dry-run", "--input", policyRepairInputPath],
      io,
      repositoryRoot,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(io.stdout)).toMatchObject({
      command: "github-policy-repair",
      dryRun: true,
      ok: true,
      result: {
        status: "planned",
        repairs: [{ code: "merge_method_drift", disposition: "auto_repair" }],
        remediationCases: [{ code: "default_branch_drift", disposition: "remediation_case" }],
      },
    });
  });

  it("refuses to apply a repair while no owner-scoped app authority exists", async () => {
    const io = new MemoryIo();
    const exitCode = await runCli(
      ["github-policy-repair", "--input", policyRepairInputPath],
      io,
      repositoryRoot,
    );

    expect(exitCode).toBe(2);
    expect(JSON.parse(io.stderr)).toMatchObject({
      ok: false,
      error: { code: "repair_apply_unavailable" },
    });
  });

  it("projects Paperclip compliance from a governance result", async () => {
    const io = new MemoryIo();
    const exitCode = await runCli(["compliance", "--input", governanceResultPath], io, repositoryRoot);

    expect(exitCode).toBe(0);
    const output = JSON.parse(io.stdout) as {
      command: string;
      ok: boolean;
      result: { status: string; scopes: { key: string; status: string; drift: string[] }[] };
    };
    expect(output).toMatchObject({ command: "compliance", ok: true, result: { status: "compliant" } });
    expect(output.result.scopes.map((scope) => scope.key)).toEqual(["maxbec", "navigaite", "edilio"]);
    expect(output.result.scopes.every((scope) => scope.drift.length === 0)).toBe(true);
  });

  it("projects pooled usage against the versioned budget policy", async () => {
    const io = new MemoryIo();
    const exitCode = await runCli(["usage", "--input", governanceResultPath], io, repositoryRoot);

    expect(exitCode).toBe(0);
    expect(JSON.parse(io.stdout)).toMatchObject({
      command: "usage",
      ok: true,
      result: {
        pool: "flama-ci-budget",
        cacheHitRate: { value: 0.75, coverage: "reported" },
        profiles: {
          fast: { targetWallSecondsP50: 180, targetRunnerSeconds: 480, withinTarget: true },
          major: { samples: 0, withinTarget: null },
        },
      },
    });
  });

  it("exits non-zero when pooled usage breaches a budget target", async () => {
    const directory = await mkdtemp(join(tmpdir(), "usage-"));
    try {
      const source = JSON.parse(await readFile(governanceResultPath, "utf8")) as {
        pooled: { fast: { wallSeconds: { p50: number; p95: number } } };
      };
      source.pooled.fast.wallSeconds = { p50: 400, p95: 500 };
      const inputPath = join(directory, "result.json");
      await writeFile(inputPath, JSON.stringify(source), "utf8");
      const io = new MemoryIo();

      const exitCode = await runCli(["usage", "--input", inputPath], io, repositoryRoot);

      expect(exitCode).toBe(1);
      expect(JSON.parse(io.stdout)).toMatchObject({
        command: "usage",
        ok: false,
        result: { profiles: { fast: { withinTarget: false } } },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
      toolVersion,
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

  it("dry-runs a project/workspace binding without exposing repository metadata", async () => {
    const io = new MemoryIo();
    const exitCode = await runCli(
      ["paperclip-bindings", "--dry-run", "--input", paperclipBindingsInputPath],
      io,
      repositoryRoot,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(io.stdout)).toMatchObject({
      command: "paperclip-bindings",
      dryRun: true,
      ok: true,
      result: { status: "planned", disposition: "planned" },
    });
    expect(io.stdout).not.toContain("maxbec/example");
    expect(io.stdout).not.toContain("10000000-0000-4000-8000-000000000001");
    expect(io.stdout).not.toContain("20000000-0000-4000-8000-000000000002");
    expect(io.stdout).not.toContain("30000000-0000-4000-8000-000000000003");
    expect(io.stderr).toBe("");
  });

  it("dry-runs a paused Paperclip routine without requesting identity or exposing live IDs", async () => {
    const io = new MemoryIo();
    const exitCode = await runCli(
      ["paperclip-routines", "--dry-run", "--input", paperclipRoutinesInputPath],
      io,
      repositoryRoot,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(io.stdout)).toMatchObject({
      command: "paperclip-routines",
      dryRun: true,
      ok: true,
      result: {
        status: "planned",
        disposition: "planned",
        initialStatus: "paused",
        trigger: { cronExpression: "17 1 * * *" },
      },
    });
    expect(io.stdout).not.toContain("10000000-0000-4000-8000-000000000001");
    expect(io.stdout).not.toContain("20000000-0000-4000-8000-000000000002");
    expect(io.stdout).not.toContain("30000000-0000-4000-8000-000000000003");
    expect(io.stderr).toBe("");
  });

  it("dry-runs the HMAC routine without identity, secret material, or live IDs", async () => {
    const io = new MemoryIo();
    const exitCode = await runCli(
      ["paperclip-github-transition-routine", "--dry-run", "--input", paperclipGithubTransitionRoutineInputPath],
      io,
      repositoryRoot,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(io.stdout)).toMatchObject({
      command: "paperclip-github-transition-routine",
      dryRun: true,
      ok: true,
      result: {
        status: "planned",
        routineDisposition: "planned",
        triggerDisposition: "planned",
        initialStatus: "paused",
        infisicalSynced: false,
        trigger: { kind: "webhook", signingMode: "hmac_sha256", replayWindowSeconds: 300 },
      },
    });
    expect(io.stdout).not.toContain("10000000-0000-4000-8000-000000000001");
    expect(io.stdout).not.toContain("20000000-0000-4000-8000-000000000002");
    expect(io.stdout).not.toContain("30000000-0000-4000-8000-000000000003");
    expect(io.stdout).not.toContain("40000000-0000-4000-8000-000000000004");
    expect(io.stdout).not.toContain("/flama/paperclip/private");
    expect(io.stdout).not.toContain("webhookSecret");
    expect(io.stderr).toBe("");
  });

  it("dry-runs read-only reconciliation without requesting identity or exposing company IDs", async () => {
    const io = new MemoryIo();
    const exitCode = await runCli(
      ["reconcile", "--dry-run", "--input", reconciliationInputPath],
      io,
      repositoryRoot,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(io.stdout)).toMatchObject({
      command: "reconcile",
      dryRun: true,
      ok: true,
      result: {
        status: "planned",
        controller: "maxbec-delivery-controller",
        mode: "read_only",
      },
    });
    expect(io.stdout).not.toContain("10000000-0000-4000-8000-000000000001");
    expect(io.stderr).toBe("");
  });

  it("audits secret metadata without reflecting secret names", async () => {
    const io = new MemoryIo();
    const temporary = await mkdtemp(join(tmpdir(), "flama-secrets-audit-"));
    const inputPath = join(temporary, "input.json");
    const dateAfter = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
    const privateKeyName = "TEST_PRIVATE_VALUE_NAME";
    await writeFile(inputPath, JSON.stringify({
      schemaVersion: 1,
      repository: { visibility: "public", isFork: false },
      infisical: {
        sourceOfTruth: true,
        projectSlug: "example-project",
        environmentMappings: [{ environment: "production", paths: ["/application/production"] }],
        machineIdentity: {
          method: "oidc",
          hardcodedClaims: true,
          shortLived: true,
          sharedAcrossRepositories: false,
          projectScoped: true,
          environmentScoped: true,
          pathScoped: true,
          claims: {
            issuerExact: true,
            audienceExact: true,
            repositoryExact: true,
            workflowExact: true,
            refOrEnvironmentExact: true,
          },
        },
      },
      publicPullRequest: {
        secrets: false,
        idToken: false,
        infisical: false,
        trustedCacheWrite: false,
        privateRunner: false,
        productionNetwork: false,
        pullRequestTarget: false,
      },
      trustedJobs: {
        broadSecretInheritance: false,
        leastPrivilegePath: true,
        buildProductionSecrets: false,
        releaseProductionSecrets: false,
        productionAfterApprovalOnly: true,
        deployApprovalBound: true,
      },
      secretSyncs: [],
      destinationSecrets: [{
        key: privateKeyName,
        destination: "github_dependabot_secret",
        delivery: "approved_destination_exception",
        rotationDays: 365,
        lastRotatedAt: new Date().toISOString().slice(0, 10),
      }],
      exceptions: [{
        key: privateKeyName,
        destination: "github_dependabot_secret",
        reason: "Runtime retrieval is unsupported by the dependency update service",
        owner: "security-owner",
        scope: "repository",
        rotationDays: 365,
        expiresAt: dateAfter(364),
        reviewAfter: dateAfter(180),
        status: "approved",
      }],
      repositoryVariables: [],
      generatedConfiguration: [],
      paperclipPrompts: [],
    }));
    try {
      const exitCode = await runCli(["secrets-audit", "--input", inputPath], io, repositoryRoot);
      expect(exitCode).toBe(0);
      expect(JSON.parse(io.stdout)).toMatchObject({
        command: "secrets-audit",
        ok: true,
        result: { status: "passed", findingCount: 0, findings: [] },
      });
      expect(io.stdout).not.toContain(privateKeyName);
      expect(io.stderr).toBe("");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("audits normalized GitHub settings without requesting an identity", async () => {
    const io = new MemoryIo();
    const exitCode = await runCli(
      ["github-policy-audit", "--input", githubPolicyInputPath],
      io,
      repositoryRoot,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(io.stdout)).toMatchObject({
      command: "github-policy-audit",
      ok: true,
      result: { status: "passed", profile: "fast", findingCount: 0, findings: [] },
    });
    expect(io.stderr).toBe("");
  });

  it("plans and audits representative canaries without exposing candidate identifiers", async () => {
    const privateRepository = "maxbec/example-fast-canary";
    const auditIo = new MemoryIo();
    const auditExit = await runCli(["canary-audit", "--input", canaryInputPath], auditIo, repositoryRoot);
    expect(auditExit).toBe(0);
    expect(JSON.parse(auditIo.stdout)).toMatchObject({
      command: "canary-audit",
      dryRun: true,
      ok: true,
      result: { status: "passed", findingCount: 0, findings: [] },
    });
    expect(auditIo.stdout).not.toContain(privateRepository);

    const temporary = await mkdtemp(join(tmpdir(), "flama-canary-plan-"));
    const planPath = join(temporary, "plan.json");
    const source = JSON.parse(await readFile(canaryInputPath, "utf8")) as {
      candidates: Array<{ evidence: unknown }>;
    };
    for (const candidate of source.candidates) candidate.evidence = null;
    await writeFile(planPath, JSON.stringify(source));
    try {
      const planIo = new MemoryIo();
      const planExit = await runCli(["canary-plan", "--input", planPath], planIo, repositoryRoot);
      expect(planExit).toBe(0);
      expect(JSON.parse(planIo.stdout)).toMatchObject({
        command: "canary-plan",
        dryRun: true,
        ok: true,
        result: { status: "planned", findingCount: 0, findings: [] },
      });
      expect(planIo.stdout).not.toContain(privateRepository);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("dry-runs an exact transition authorization without requesting database identity", async () => {
    const io = new MemoryIo();
    const temporary = await mkdtemp(join(tmpdir(), "flama-transition-authorization-"));
    const inputPath = join(temporary, "input.json");
    const authorizedAt = new Date();
    const privateCaseId = "40000000-0000-4000-8000-000000000004";
    await writeFile(inputPath, JSON.stringify({
      schemaVersion: 1,
      company: "Private",
      controller: "maxbec-delivery-controller",
      deliveryId: "private-delivery-id",
      transitionKind: "pull_request.opened",
      bindingDigest: `sha256:${"d".repeat(64)}`,
      evidenceDigest: `sha256:${"e".repeat(64)}`,
      case: {
        id: privateCaseId,
        pipelineId: "50000000-0000-4000-8000-000000000005",
        pipelineKey: "flama-feature-fix-v1",
        fromStageKey: "preflight_passed",
        toStageKey: "pr_open",
      },
      authorizedAt: authorizedAt.toISOString(),
      expiresAt: new Date(authorizedAt.getTime() + 30 * 60 * 1_000).toISOString(),
      mutationAllowed: true,
    }));

    const exitCode = await runCli(
      ["paperclip-transition-authorize", "--dry-run", "--input", inputPath],
      io,
      repositoryRoot,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(io.stdout)).toMatchObject({
      command: "paperclip-transition-authorize",
      dryRun: true,
      ok: true,
      result: { status: "planned", disposition: "planned" },
    });
    expect(io.stdout).not.toContain("private-delivery-id");
    expect(io.stdout).not.toContain(privateCaseId);
    expect(io.stderr).toBe("");
  });
});
