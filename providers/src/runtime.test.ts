import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDeploymentAdapter, SystemCommandRunner } from "./runtime.js";

const adapterSource = `
module.exports.createAdapter = function createAdapter() {
  return {
    name: "custom",
    async validate() { return true; },
    async deploy() {},
    async health() { return true; },
    async rollback() {},
    async deploymentUrl() { return "https://example.invalid"; },
    async deployedVersion() { return "1.0.0"; },
    async evidence() { return { deploymentId: "one", observedAt: new Date().toISOString() }; }
  };
};
`;

describe("deployment adapter loader", () => {
  it("loads a regular repository-relative adapter with the expected provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "flama-adapter-"));
    await writeFile(join(root, "provider.cjs"), adapterSource, "utf8");

    await expect(loadDeploymentAdapter(root, "provider.cjs", "custom")).resolves.toMatchObject({
      name: "custom",
    });
  });

  it("rejects traversal and provider mismatches", async () => {
    const root = await mkdtemp(join(tmpdir(), "flama-adapter-deny-"));
    await writeFile(join(root, "provider.cjs"), adapterSource, "utf8");

    await expect(loadDeploymentAdapter(root, "../provider.cjs", "custom")).rejects.toThrow(
      /repository relative/,
    );
    await expect(loadDeploymentAdapter(root, "provider.cjs", "render")).rejects.toThrow(
      /does not match/,
    );
  });

  it("rejects an adapter reached through a symlinked parent", async () => {
    const root = await mkdtemp(join(tmpdir(), "flama-adapter-symlink-"));
    const outside = await mkdtemp(join(tmpdir(), "flama-adapter-outside-"));
    await mkdir(join(outside, "nested"));
    await writeFile(join(outside, "nested", "provider.cjs"), adapterSource, "utf8");
    await symlink(join(outside, "nested"), join(root, ".flama"), "dir");

    await expect(loadDeploymentAdapter(root, ".flama/provider.cjs", "custom")).rejects.toThrow(
      /parent must be a real directory/,
    );
  });
});

describe("system command runner", () => {
  it("captures stdout and a success code without a shell", async () => {
    const result = await new SystemCommandRunner().run("node", ["--version"]);

    expect(result.code).toBe(0);
    expect(result.stdout.trim().startsWith("v")).toBe(true);
  });

  it("reports a non-zero exit code instead of throwing", async () => {
    const result = await new SystemCommandRunner().run("node", ["-e", "process.exit(3)"]);

    expect(result.code).toBe(3);
  });

  it("passes deployment values through the environment, never the argument list", async () => {
    const result = await new SystemCommandRunner().run(
      "node",
      ["-e", "process.stdout.write(process.env.FLAMA_IMAGE ?? 'absent')"],
      { FLAMA_IMAGE: "ghcr.io/maxbec/api@sha256:deadbeef" },
    );

    expect(result.stdout).toBe("ghcr.io/maxbec/api@sha256:deadbeef");
  });

  it("does not inherit unrelated parent environment variables", async () => {
    process.env["FLAMA_RUNTIME_TEST_LEAK"] = "leaked";
    try {
      const result = await new SystemCommandRunner().run(
        "node",
        ["-e", "process.stdout.write(process.env.FLAMA_RUNTIME_TEST_LEAK ?? 'absent')"],
      );

      expect(result.stdout).toBe("absent");
    } finally {
      delete process.env["FLAMA_RUNTIME_TEST_LEAK"];
    }
  });

  it("rejects a command name that is not a bare executable", async () => {
    await expect(new SystemCommandRunner().run("../bin/docker", ["ps"])).rejects.toThrow();
  });
});
