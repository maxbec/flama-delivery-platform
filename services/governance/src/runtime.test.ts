import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPaperclipGovernanceAttestation } from "../../../packages/contracts/src/paperclip-governance-attestation.js";
import { runGovernanceRuntime } from "./runtime.js";

const keys = ["maxbec", "navigaite", "edilio"] as const;
const identities = {
  maxbec: { company: "Private", controller: "maxbec-delivery-controller", runId: "11111111-1111-4111-8111-111111111111" },
  navigaite: { company: "// Navigaite", controller: "navigaite-delivery-controller", runId: "22222222-2222-4222-8222-222222222222" },
  edilio: { company: "Edilio", controller: "edilio-delivery-controller", runId: "33333333-3333-4333-8333-333333333333" },
} as const;

// The scope key and the GitHub owner are different identifiers.
const githubOwners = { maxbec: "maxbec", navigaite: "navigaite", edilio: "edilio-app" } as const;

function environment(attestationDirectory?: string): Record<string, string> {
  return {
    ...Object.fromEntries(keys.flatMap((key) => {
    const prefix = `FLAMA_GOVERNANCE_${key.toUpperCase()}`;
    return [
      [`${prefix}_GITHUB_TOKEN`, `test-only-${key}-github-credential`],
    ];
    })),
    ...(attestationDirectory === undefined
      ? {}
      : { FLAMA_RECONCILIATION_EVIDENCE_DIR: attestationDirectory }),
  };
}

function privateInput(): unknown {
  return {
    schemaVersion: 1,
    window: { from: "2026-07-01T00:00:00.000Z", to: "2026-07-08T00:00:00.000Z" },
    scopes: keys.map((key) => ({
      key,
      company: identities[key].company,
      githubOwner: githubOwners[key],
      controller: identities[key].controller,
      paperclipAttestation: createPaperclipGovernanceAttestation({
        source: "paperclip-company-controller",
        company: identities[key].company,
        controller: identities[key].controller,
        runId: identities[key].runId,
        observedAt: "2026-07-07T23:59:00.000Z",
        checks: {
          company: "compliant",
          controller: key === "edilio" ? "drift" : "compliant",
          lifecycles: "compliant",
        },
      }),
      repositories: [],
    })),
  };
}

describe("governance runtime", () => {
  it("writes private evidence and exposes only its digest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flama-governance-test-"));
    const attestationDirectory = join(directory, "attestations");
    await mkdir(attestationDirectory);
    const inputPath = join(directory, "input.json");
    const outputPath = join(directory, "result.json");
    const input = privateInput() as {
      scopes: Array<{ paperclipAttestation: { runId: string } }>;
    };
    await writeFile(inputPath, JSON.stringify(input), { mode: 0o600 });
    for (const scope of input.scopes) {
      await writeFile(
        join(attestationDirectory, `paperclip-governance-${scope.paperclipAttestation.runId}.json`),
        JSON.stringify(scope.paperclipAttestation),
        { mode: 0o600 },
      );
    }
    let stdout = "";
    let stderr = "";
    const exitCode = await runGovernanceRuntime(
      ["--input", inputPath, "--output", outputPath],
      environment(attestationDirectory),
      { writeStdout: (value) => { stdout += value; }, writeStderr: (value) => { stderr += value; } },
      async () => { throw new Error("no GitHub request expected without repository selectors"); },
    );
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toMatch(/^\{"status":"collected","digest":"sha256:[0-9a-f]{64}"\}\n$/u);
    expect(stdout).not.toContain(identities.maxbec.runId);
    expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
    const result = JSON.parse(await readFile(outputPath, "utf8")) as { status: string };
    expect(result.status).toBe("attention");
  });

  it("does not expose credentials or private paths on failure", async () => {
    let stderr = "";
    const secretPath = "/missing/private-input-name";
    const exitCode = await runGovernanceRuntime(
      ["--input", secretPath, "--output", "/missing/private-output-name"],
      environment(),
      { writeStdout() {}, writeStderr: (value) => { stderr += value; } },
    );
    expect(exitCode).toBe(1);
    expect(stderr).toBe('{"status":"failed","reason":"governance_runtime_failure"}\n');
    expect(stderr).not.toContain(secretPath);
    expect(stderr).not.toContain("test-only");
  });

  it("rejects governance input that does not match native controller evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flama-governance-mismatch-"));
    const attestationDirectory = join(directory, "attestations");
    await mkdir(attestationDirectory);
    const inputPath = join(directory, "input.json");
    const outputPath = join(directory, "result.json");
    const input = privateInput() as {
      scopes: Array<{ paperclipAttestation: ReturnType<typeof createPaperclipGovernanceAttestation> }>;
    };
    await writeFile(inputPath, JSON.stringify(input), { mode: 0o600 });
    for (const [index, scope] of input.scopes.entries()) {
      let attestation = scope.paperclipAttestation;
      if (index === 0) {
        const { evidenceDigest: _evidenceDigest, ...payload } = scope.paperclipAttestation;
        attestation = createPaperclipGovernanceAttestation({
          ...payload,
          checks: { ...payload.checks, lifecycles: "drift" },
        });
      }
      await writeFile(
        join(attestationDirectory, `paperclip-governance-${scope.paperclipAttestation.runId}.json`),
        JSON.stringify(attestation),
        { mode: 0o600 },
      );
    }
    let stderr = "";
    const exitCode = await runGovernanceRuntime(
      ["--input", inputPath, "--output", outputPath],
      environment(attestationDirectory),
      { writeStdout() {}, writeStderr: (value) => { stderr += value; } },
    );
    expect(exitCode).toBe(1);
    expect(stderr).toBe('{"status":"failed","reason":"governance_runtime_failure"}\n');
    expect(stderr).not.toContain(input.scopes[0]!.paperclipAttestation.runId);
  });
});
