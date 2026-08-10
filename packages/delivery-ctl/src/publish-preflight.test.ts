import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { PublishPreflightError, publishPreflight } from "./publish-preflight.js";

const temporaryDirectories: string[] = [];

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const environment = {
  FLAMA_GITHUB_APP_ID_MAXBEC: "150130477",
  FLAMA_GITHUB_APP_PRIVATE_KEY_MAXBEC: privateKey,
};

/** A real repository, because runPreflight verifies HEAD and worktree cleanliness. */
async function checkout(failAffected = false): Promise<{ root: string; headSha: string }> {
  const root = await mkdtemp(join(tmpdir(), "flama-publish-preflight-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "scripts"));
  await writeFile(
    join(root, "scripts", "delivery"),
    `#!/usr/bin/env node\nprocess.exit(${failAffected ? "process.argv[2] === 'affected' ? 1 : 0" : "0"});\n`,
    "utf8",
  );
  await chmod(join(root, "scripts", "delivery"), 0o755);
  const git = (args: readonly string[]) => spawnSync("git", [...args], { cwd: root, encoding: "utf8" });
  git(["init", "-q"]);
  git(["add", "scripts/delivery"]);
  git([
    "-c", "commit.gpgsign=false", "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "commit", "-qm", "fixture",
  ]);
  return { root, headSha: git(["rev-parse", "HEAD"]).stdout.trim() };
}

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

function githubStub(
  overrides: { readonly repository?: unknown; readonly repositoryStatus?: number } = {},
  calls: Call[] = [],
): typeof fetch {
  return (async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    const json = (value: unknown, status: number) =>
      new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

    if (url.endsWith("/installation")) return json({ id: 1 }, 200);
    // publish-check re-verifies the token scope itself rather than trusting the
    // caller, so the stub has to answer as a single-repository token would.
    if (url.includes("/installation/repositories")) {
      return json({ total_count: 1, repositories: [{ full_name: "maxbec/example" }] }, 200);
    }
    if (url.endsWith("/access_tokens")) {
      return json(
        { token: "ghs_stub-token-value", expires_at: "2026-08-10T09:00:00Z", permissions: { checks: "write" } },
        201,
      );
    }
    if (url.endsWith("/repos/maxbec/example")) {
      return json(
        overrides.repository ?? { full_name: "maxbec/example", fork: false, archived: false, disabled: false },
        overrides.repositoryStatus ?? 200,
      );
    }
    if (url.includes("/check-runs")) {
      if ((init?.method ?? "GET") === "GET") return json({ check_runs: [] }, 200);
      const body = JSON.parse(String(init?.body));
      return json({ id: 99, name: body.name, external_id: body.external_id, head_sha: body.head_sha, app: { slug: "flama-delivery-maxbec" }, status: "completed", conclusion: "success" }, 201);
    }
    return json({}, 200);
  }) as typeof fetch;
}

function run(root: string, headSha: string, fetchImplementation: typeof fetch) {
  return publishPreflight({
    repository: "maxbec/example",
    headSha,
    baseSha: headSha,
    releaseImpact: "patch",
    checkoutDirectory: root,
    environment,
    runnerId: "11111111-1111-4111-8111-111111111111",
    fetchImplementation,
    // Real clock on purpose: certify refuses a signature that predates the run
    // it attests, and the run finishes at wall-clock time.
  });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("preflight publication", () => {
  it("publishes an app-authored check bound to the exact head", async () => {
    const { root, headSha } = await checkout();
    const calls: Call[] = [];
    const result = await run(root, headSha, githubStub({}, calls));

    expect(result.status).toBe("published");
    const created = calls.find((call) => call.method === "POST" && call.url.includes("/check-runs"));
    expect(created?.body).toMatchObject({ head_sha: headSha });
    expect((created?.body as { external_id: string }).external_id).toMatch(
      /^paperclip-preflight:sha256:[0-9a-f]{64}$/u,
    );
  });

  /*
   * The whole point of the gate: a head whose own delivery commands failed must
   * leave it red. Publishing anything here would assert evidence never observed.
   */
  it("does not publish when the preflight fails", async () => {
    const { root, headSha } = await checkout(true);
    const calls: Call[] = [];
    const result = await run(root, headSha, githubStub({}, calls));

    expect(result).toMatchObject({ status: "preflight_failed", failedCommand: "./scripts/delivery affected" });
    expect(calls.filter((call) => call.method === "POST" && call.url.includes("/check-runs"))).toEqual([]);
  });

  it("refuses a fork, which would lend the controller's authority to an outside head", async () => {
    const { root, headSha } = await checkout();
    await expect(
      run(root, headSha, githubStub({ repository: { full_name: "maxbec/example", fork: true, archived: false } })),
    ).rejects.toMatchObject({ code: "preflight_repository_ineligible" });
  });

  it("refuses an archived repository", async () => {
    const { root, headSha } = await checkout();
    await expect(
      run(root, headSha, githubStub({ repository: { full_name: "maxbec/example", fork: false, archived: true } })),
    ).rejects.toMatchObject({ code: "preflight_repository_ineligible" });
  });

  it("refuses a repository whose identity does not match the request", async () => {
    const { root, headSha } = await checkout();
    await expect(
      run(root, headSha, githubStub({ repository: { full_name: "maxbec/other", fork: false, archived: false } })),
    ).rejects.toMatchObject({ code: "preflight_repository_ineligible" });
  });

  it("refuses an owner with no bound controller", async () => {
    const { root, headSha } = await checkout();
    await expect(
      publishPreflight({
        repository: "someone-else/example",
        headSha,
        baseSha: headSha,
        releaseImpact: "patch",
        checkoutDirectory: root,
        environment,
        runnerId: "11111111-1111-4111-8111-111111111111",
        fetchImplementation: githubStub(),
      }),
    ).rejects.toBeInstanceOf(PublishPreflightError);
  });
});
