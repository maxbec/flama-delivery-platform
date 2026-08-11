import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { sweepPreflights } from "./preflight-sweep.js";

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

/** An upstream the sweep can genuinely fetch and run preflight against. */
async function upstream(failAffected = false): Promise<{ url: string; headSha: string }> {
  const root = await mkdtemp(join(tmpdir(), "flama-sweep-upstream-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "scripts"));
  await writeFile(
    join(root, "scripts", "delivery"),
    `#!/usr/bin/env node\nprocess.exit(${failAffected ? "process.argv[2] === 'affected' ? 1 : 0" : "0"});\n`,
    "utf8",
  );
  await chmod(join(root, "scripts", "delivery"), 0o755);
  const git = (args: readonly string[]) => spawnSync("git", [...args], { cwd: root, encoding: "utf8" });
  git(["init", "-q", "-b", "main"]);
  git(["add", "scripts/delivery"]);
  git([
    "-c", "commit.gpgsign=false", "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "commit", "-qm", "fixture",
  ]);
  return { url: root, headSha: git(["rev-parse", "HEAD"]).stdout.trim() };
}

interface PullSpec {
  readonly number: number;
  readonly headSha: string;
  readonly isFork?: boolean;
  readonly hasPreflight?: boolean;
  /** Head predating the delivery profile: no scripts/delivery in its tree. */
  readonly unadopted?: boolean;
}

function githubStub(pulls: readonly PullSpec[], created: string[] = []): typeof fetch {
  return (async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

    if (url.endsWith("/app/installations")) return json([{ id: 1, account: { login: "maxbec" } }]);
    if (url.endsWith("/installation")) return json({ id: 1 });
    if (url.endsWith("/access_tokens")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      return json({ token: "ghs_stub", expires_at: "2030-01-01T00:00:00Z", permissions: body.permissions }, 201);
    }
    if (url.includes("/installation/repositories")) {
      return json({ total_count: 1, repositories: [{ full_name: "maxbec/example", archived: false, disabled: false }] });
    }
    // Scope is decided at the head: a pull request opened before the repository
    // adopted the profile has no entrypoint in its own tree.
    if (url.includes("/contents/scripts/delivery")) {
      const ref = url.split("ref=")[1];
      return pulls.some((pull) => pull.headSha === ref && pull.unadopted)
        ? json({ message: "Not Found" }, 404)
        : json({ name: "delivery" });
    }
    if (url.includes("/pulls?state=open")) {
      return json(pulls.map((pull) => ({
        number: pull.number,
        head: { sha: pull.headSha, repo: { full_name: pull.isFork ? "outsider/example" : "maxbec/example" } },
        base: { sha: pull.headSha },
      })));
    }
    if (url.includes("/check-runs")) {
      if (method === "GET") {
        const sha = url.split("/commits/")[1]?.split("/")[0];
        const spec = pulls.find((pull) => pull.headSha === sha);
        return json({
          check_runs: spec?.hasPreflight
            ? [{
              name: "Paperclip Preflight", conclusion: "success", app: { slug: "flama-delivery-maxbec" },
              external_id: `paperclip-preflight:sha256:${"a".repeat(64)}`,
            }]
            : [],
        });
      }
      const body = JSON.parse(String(init?.body));
      created.push(body.head_sha);
      return json({ id: 1, name: body.name, external_id: body.external_id, head_sha: body.head_sha, app: { slug: "flama-delivery-maxbec" }, status: "completed", conclusion: "success" }, 201);
    }
    if (url.endsWith("/repos/maxbec/example")) {
      return json({ full_name: "maxbec/example", fork: false, archived: false, disabled: false });
    }
    return json({});
  }) as typeof fetch;
}

async function cacheRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flama-sweep-cache-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("preflight sweep", () => {
  it("skips heads that already carry a valid preflight and forks, and publishes the rest", async () => {
    const { headSha } = await upstream();
    const created: string[] = [];
    const outcomes = await sweepPreflights({
      owner: "maxbec",
      appSlug: "flama-delivery-maxbec",
      environment,
      cacheRoot: await cacheRoot(),
      runnerId: "11111111-1111-4111-8111-111111111111",
      fetchImplementation: githubStub(
        [
          { number: 1, headSha, hasPreflight: true },
          // A distinct head: the check-runs lookup is keyed by SHA, so sharing
          // one would make the fork inherit the other's preflight.
          { number: 2, headSha: "3".repeat(40), isFork: true },
        ],
        created,
      ),
    });

    expect(outcomes.map(({ number, status }) => `${number}:${status}`)).toEqual([
      "1:already_published",
      "2:skipped_fork",
    ]);
    // Neither path may reach publication.
    expect(created).toEqual([]);
  });

  it("records a failing head without abandoning the pass", async () => {
    const { headSha } = await upstream();
    const outcomes = await sweepPreflights({
      owner: "maxbec",
      appSlug: "flama-delivery-maxbec",
      environment,
      cacheRoot: await cacheRoot(),
      runnerId: "11111111-1111-4111-8111-111111111111",
      // A head the upstream does not carry: the fetch cannot resolve it.
      fetchImplementation: githubStub([{ number: 3, headSha: "0".repeat(40) }]),
    });

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ number: 3, status: "failed" });
    expect(typeof outcomes[0]?.code).toBe("string");
  });

  /*
   * The first live sweep failed ten heads with delivery_entrypoint_invalid
   * because scope was checked on the default branch, where the profile exists,
   * rather than on the head being preflighted, where it did not.
   */
  it("ignores heads that predate the delivery profile instead of failing them", async () => {
    const { headSha } = await upstream();
    const outcomes = await sweepPreflights({
      owner: "maxbec",
      appSlug: "flama-delivery-maxbec",
      environment,
      cacheRoot: await cacheRoot(),
      runnerId: "11111111-1111-4111-8111-111111111111",
      fetchImplementation: githubStub([
        { number: 7, headSha: "4".repeat(40), unadopted: true },
        { number: 8, headSha },
      ]),
    });

    // The unadopted head is not reported at all — it was never discoverable.
    // The adopted one is attempted; whether it then publishes depends on the
    // fetch, which this suite deliberately does not put on the network.
    expect(outcomes.map(({ number }) => number)).toEqual([8]);
  });

  it("bounds one pass so a backlog cannot hold the controller", async () => {
    const outcomes = await sweepPreflights({
      owner: "maxbec",
      appSlug: "flama-delivery-maxbec",
      environment,
      cacheRoot: await cacheRoot(),
      runnerId: "11111111-1111-4111-8111-111111111111",
      maximumPublications: 1,
      fetchImplementation: githubStub([
        { number: 4, headSha: "0".repeat(40) },
        { number: 5, headSha: "1".repeat(40) },
        { number: 6, headSha: "2".repeat(40) },
      ]),
    });

    // Only the bound is attempted, and the remainder is reported rather than
    // dropped: an unreported head reads as one that was never eligible.
    expect(outcomes.map(({ number, status }) => `${number}:${status}`)).toEqual([
      "4:failed",
      "5:deferred",
      "6:deferred",
    ]);
  });

  /*
   * Counting heads bounds nothing in wall-clock — the cost of a head is the
   * repository's own delivery commands. The first pass whose checkouts really
   * succeeded ran past the controller's run timeout and was killed with its
   * accounting lost, so the pass has to stop on its own clock.
   */
  it("stops starting heads once the time budget is spent", async () => {
    const { headSha } = await upstream();
    // Time only advances when the sweep reads it, so the budget is spent by
    // construction rather than by making the suite wait.
    let reading = 0;
    const outcomes = await sweepPreflights({
      owner: "maxbec",
      appSlug: "flama-delivery-maxbec",
      environment,
      cacheRoot: await cacheRoot(),
      runnerId: "11111111-1111-4111-8111-111111111111",
      budgetMilliseconds: 1,
      now: () => new Date(Date.UTC(2026, 0, 1) + (reading += 1) * 1_000),
      fetchImplementation: githubStub([{ number: 9, headSha }, { number: 10, headSha: "5".repeat(40) }]),
    });

    // Neither head is attempted: the budget was already spent when the first
    // was considered, and a spent budget defers rather than fails.
    expect(outcomes.every(({ status }) => status === "deferred")).toBe(true);
    expect(outcomes).toHaveLength(2);
  });
});
