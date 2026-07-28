import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDeploymentAdapter } from "./runtime.js";

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
