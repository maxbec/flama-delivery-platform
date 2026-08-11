import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { prepareCheckout, RepositoryCheckoutError } from "./repository-checkout.js";

const temporaryDirectories: string[] = [];

/**
 * A real upstream on disk. Production fetches over https, but every property
 * worth proving — head positioning, cleanliness, isolation between heads — is
 * observable against a local remote, and a local remote keeps the suite off the
 * network and deterministic.
 */
async function upstream(): Promise<{ url: string; first: string; second: string }> {
  const root = await mkdtemp(join(tmpdir(), "flama-checkout-upstream-"));
  temporaryDirectories.push(root);
  const git = (args: readonly string[]) => spawnSync("git", [...args], { cwd: root, encoding: "utf8" });
  const commit = (message: string) =>
    git([
      "-c", "commit.gpgsign=false", "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
      "commit", "-qm", message,
    ]);

  git(["init", "-q", "-b", "main"]);
  await writeFile(join(root, "file.txt"), "first\n", "utf8");
  git(["add", "file.txt"]);
  commit("first");
  const first = git(["rev-parse", "HEAD"]).stdout.trim();
  await writeFile(join(root, "file.txt"), "second\n", "utf8");
  git(["add", "file.txt"]);
  commit("second");
  const second = git(["rev-parse", "HEAD"]).stdout.trim();
  return { url: root, first, second };
}

async function cacheRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flama-checkout-cache-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("repository checkout", () => {
  it("positions a clean worktree on the exact requested head", async () => {
    const { url, first, second } = await upstream();
    const checkout = await prepareCheckout({
      repository: "maxbec/example",
      headSha: first,
      cacheRoot: await cacheRoot(),
      token: "unused-for-a-local-remote",
      remoteUrl: url,
    });

    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: checkout.path, encoding: "utf8" });
    expect(head.stdout.trim()).toBe(first);
    expect(head.stdout.trim()).not.toBe(second);

    const status = spawnSync("git", ["status", "--porcelain=v1"], { cwd: checkout.path, encoding: "utf8" });
    expect(status.stdout).toBe("");

    // The head's content, not the tip's — preflight must observe this commit.
    expect(await readFile(join(checkout.path, "file.txt"), "utf8")).toBe("first\n");

    await checkout.release();
  });

  /*
   * Refs are not enough. A delivery command's tooling asks git which remote it
   * is on and then looks under `refs/remotes/<name>/`; with no configured
   * remote that name is empty, the lookup lands on `refs/remotes//main`, and
   * it fails while `refs/remotes/origin/main` sits right there. Every
   * platzl-finder head failed this way — `trunk check` reporting "Unable to
   * detect an upstream commit on this branch" — and the identical command
   * passes in an ordinary clone.
   */
  it("leaves the worktree able to resolve its upstream", async () => {
    const { url, first } = await upstream();
    const checkout = await prepareCheckout({
      repository: "maxbec/example",
      headSha: first,
      cacheRoot: await cacheRoot(),
      token: "unused-for-a-local-remote",
      remoteUrl: url,
    });

    const resolved = (args: readonly string[]) =>
      spawnSync("git", [...args], { cwd: checkout.path, encoding: "utf8" });

    // The name the tooling reads back, and the ref it then builds from it.
    expect(resolved(["remote"]).stdout.trim()).toBe("origin");
    expect(resolved(["rev-parse", "--verify", "refs/remotes/origin/main"]).status).toBe(0);
    // The default branch, which is what "upstream" resolves to when the head
    // is detached and carries no branch of its own.
    expect(resolved(["rev-parse", "--verify", "refs/remotes/origin/HEAD"]).status).toBe(0);

    await checkout.release();
  });

  it("gives each head its own worktree so two runs cannot share a tree", async () => {
    const { url, first, second } = await upstream();
    const root = await cacheRoot();
    const shared = { repository: "maxbec/example", cacheRoot: root, token: "unused", remoteUrl: url };

    const a = await prepareCheckout({ ...shared, headSha: first });
    const b = await prepareCheckout({ ...shared, headSha: second });

    expect(a.path).not.toBe(b.path);
    expect(await readFile(join(a.path, "file.txt"), "utf8")).toBe("first\n");
    expect(await readFile(join(b.path, "file.txt"), "utf8")).toBe("second\n");

    await a.release();
    await b.release();
  });

  /* An interrupted run must not leave a tree that the next run silently reuses. */
  it("replaces a residual worktree rather than reusing it", async () => {
    const { url, first } = await upstream();
    const root = await cacheRoot();
    const shared = { repository: "maxbec/example", cacheRoot: root, token: "unused", remoteUrl: url };

    const first_ = await prepareCheckout({ ...shared, headSha: first });
    await writeFile(join(first_.path, "residue.txt"), "left behind", "utf8");

    const again = await prepareCheckout({ ...shared, headSha: first });
    const status = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: again.path,
      encoding: "utf8",
    });
    expect(status.stdout).toBe("");
    await again.release();
  });

  it("removes the worktree on release and keeps the mirror for the next head", async () => {
    const { url, first } = await upstream();
    const root = await cacheRoot();
    const checkout = await prepareCheckout({
      repository: "maxbec/example",
      headSha: first,
      cacheRoot: root,
      token: "unused",
      remoteUrl: url,
    });

    await checkout.release();
    await expect(stat(checkout.path)).rejects.toThrow();
    await expect(stat(join(root, "maxbec__example.git"))).resolves.toBeTruthy();
  });

  it("refuses a head the remote does not carry", async () => {
    const { url } = await upstream();
    await expect(
      prepareCheckout({
        repository: "maxbec/example",
        headSha: "0".repeat(40),
        cacheRoot: await cacheRoot(),
        token: "unused",
        remoteUrl: url,
      }),
    ).rejects.toMatchObject({ code: "checkout_head_mismatch" });
  });

  it("refuses a repository name that is not owner/name", async () => {
    await expect(
      prepareCheckout({
        repository: "not-a-repo",
        headSha: "0".repeat(40),
        cacheRoot: await cacheRoot(),
        token: "unused",
      }),
    ).rejects.toMatchObject({ code: "checkout_repository_invalid" });
  });

  it("refuses a head that is not a full commit sha", async () => {
    await expect(
      prepareCheckout({
        repository: "maxbec/example",
        headSha: "abc123",
        cacheRoot: await cacheRoot(),
        token: "unused",
      }),
    ).rejects.toBeInstanceOf(RepositoryCheckoutError);
  });
});
