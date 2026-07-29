import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runGovernanceRuntime } from "./runtime.js";

const keys = ["maxbec", "navigaite", "edilio"] as const;
const identities = {
  maxbec: { company: "Private", controller: "maxbec-delivery-controller", id: "11111111-1111-4111-8111-111111111111" },
  navigaite: { company: "// Navigaite", controller: "navigaite-delivery-controller", id: "22222222-2222-4222-8222-222222222222" },
  edilio: { company: "Edilio", controller: "edilio-delivery-controller", id: "33333333-3333-4333-8333-333333333333" },
} as const;

function environment(): Record<string, string> {
  return Object.fromEntries(keys.flatMap((key) => {
    const prefix = `FLAMA_GOVERNANCE_${key.toUpperCase()}`;
    return [
      [`${prefix}_PAPERCLIP_API_URL`, "http://127.0.0.1:3100"],
      [`${prefix}_PAPERCLIP_API_KEY`, `test-only-${key}-paperclip-credential`],
      [`${prefix}_GITHUB_TOKEN`, `test-only-${key}-github-credential`],
    ];
  }));
}

function privateInput(): unknown {
  return {
    schemaVersion: 1,
    window: { from: "2026-07-01T00:00:00.000Z", to: "2026-07-08T00:00:00.000Z" },
    scopes: keys.map((key) => ({
      key,
      company: identities[key].company,
      companyId: identities[key].id,
      githubOwner: key,
      controller: identities[key].controller,
      repositories: [],
    })),
  };
}

function responseFor(url: string): Response {
  const key = keys.find((candidate) => url.includes(identities[candidate].id));
  if (key === undefined) return new Response("missing", { status: 404 });
  if (url.endsWith("/agents")) {
    return Response.json([{
      id: "44444444-4444-4444-8444-444444444444",
      companyId: identities[key].id,
      name: identities[key].controller,
      role: "devops",
      adapterType: "process",
      budgetMonthlyCents: 0,
      status: key === "edilio" ? "pending_approval" : "paused",
      desiredSkills: ["flama-paperclip-delivery"],
      permissions: { canCreateAgents: false, canCreateSkills: false, canAssignTasks: false },
      metadata: { managedBy: "flama-delivery-platform", topologyVersion: 1 },
    }]);
  }
  if (url.endsWith("/pipelines")) {
    return Response.json([
      { key: "flama-project-bootstrap-v1", enforceTransitions: true, archivedAt: null },
      { key: "flama-feature-fix-v1", enforceTransitions: true, archivedAt: null },
      { key: "flama-release-deployment-v1", enforceTransitions: true, archivedAt: null },
    ]);
  }
  return Response.json({ id: identities[key].id, name: identities[key].company, status: "active" });
}

describe("governance runtime", () => {
  it("writes private evidence and exposes only its digest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flama-governance-test-"));
    const inputPath = join(directory, "input.json");
    const outputPath = join(directory, "result.json");
    await writeFile(inputPath, JSON.stringify(privateInput()), { mode: 0o600 });
    let stdout = "";
    let stderr = "";
    const exitCode = await runGovernanceRuntime(
      ["--input", inputPath, "--output", outputPath],
      environment(),
      { writeStdout: (value) => { stdout += value; }, writeStderr: (value) => { stderr += value; } },
      async (input, init) => {
        expect(init?.method).toBe("GET");
        return responseFor(String(input));
      },
    );
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toMatch(/^\{"status":"collected","digest":"sha256:[0-9a-f]{64}"\}\n$/u);
    expect(stdout).not.toContain(identities.maxbec.id);
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
});
