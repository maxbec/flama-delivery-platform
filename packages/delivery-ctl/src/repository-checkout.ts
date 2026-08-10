import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * Provides the clean checkout `runPreflight` insists on: a worktree whose HEAD
 * is exactly the requested commit and whose tree is untouched.
 *
 * The controller has no checkout of the repositories it publishes checks for —
 * its own workspace is the platform runtime — so without this the chain has
 * nothing to run `./scripts/delivery` against. A bare mirror is kept per
 * repository and a detached worktree is created per head, so a re-run costs a
 * fetch rather than a clone and two heads never share a tree.
 *
 * The installation token is passed through the environment rather than the
 * command line. Process arguments are world-readable through `/proc`, while
 * `/proc/<pid>/environ` is readable only by the owning user, and a token in
 * argv would also reach any `ps` output captured in a log or an incident note.
 */

const authorizationConfigKey = "http.extraHeader";

export type RepositoryCheckoutErrorCode =
  | "checkout_fetch_failed"
  | "checkout_head_mismatch"
  | "checkout_repository_invalid"
  | "checkout_worktree_failed"
  | "checkout_worktree_unclean";

export class RepositoryCheckoutError extends Error {
  override readonly name = "RepositoryCheckoutError";

  constructor(readonly code: RepositoryCheckoutErrorCode) {
    super("repository checkout refused");
  }
}

interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
}

/**
 * `git` inherits only PATH plus whatever configuration is handed in. Nothing
 * else from the controller's environment reaches a child process.
 */
async function runGit(
  args: readonly string[],
  cwd: string,
  configuration: Readonly<Record<string, string>> = {},
): Promise<ProcessResult> {
  const entries = Object.entries(configuration);
  const environment: Record<string, string> = {
    PATH: process.env["PATH"] ?? "",
    // git needs HOME even when it reads no user configuration: without it
    // `worktree add` completes the checkout and still exits non-zero, which
    // read as checkout_worktree_failed for every head in one repository while
    // the identical command succeeded by hand. Global config is neutralised
    // through GIT_CONFIG_GLOBAL instead, which is explicit about the intent.
    HOME: process.env["HOME"] ?? "",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: String(entries.length),
  };
  entries.forEach(([key, value], index) => {
    environment[`GIT_CONFIG_KEY_${index}`] = key;
    environment[`GIT_CONFIG_VALUE_${index}`] = value;
  });

  return new Promise((resolveProcess) => {
    const child = spawn("git", [...args], {
      cwd,
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length <= 1_048_576) stdout += chunk;
    });
    child.once("error", () => resolveProcess({ exitCode: 127, stdout: "" }));
    child.once("exit", (code, signal) => {
      resolveProcess({ exitCode: signal === null && code !== null ? code : 124, stdout });
    });
  });
}

function authorizationConfiguration(token: string): Readonly<Record<string, string>> {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return { [authorizationConfigKey]: `Authorization: Basic ${basic}` };
}

export interface PrepareCheckoutInput {
  /** `owner/name`. */
  readonly repository: string;
  readonly headSha: string;
  /** Directory holding the per-repository mirrors and worktrees. */
  readonly cacheRoot: string;
  /** Installation token; only ever reaches git through the environment. */
  readonly token: string;
  /**
   * Defaults to the repository's GitHub URL. Overridable so the behaviour that
   * matters — head positioning, cleanliness, worktree isolation — can be proven
   * against a local remote instead of asserted about the network.
   */
  readonly remoteUrl?: string;
}

export interface PreparedCheckout {
  readonly path: string;
  /** Removes the worktree. The mirror is kept so the next head only fetches. */
  release(): Promise<void>;
}

/**
 * Fetches `headSha` and hands back a detached worktree positioned on it.
 *
 * Pull request heads are fetched explicitly through `refs/pull/*` because a
 * head can belong to a branch that no longer exists, and a bare `fetch origin`
 * would not carry it.
 */
export async function prepareCheckout(input: PrepareCheckoutInput): Promise<PreparedCheckout> {
  if (
    !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u.test(input.repository) ||
    !/^[0-9a-f]{40}$/u.test(input.headSha)
  ) {
    throw new RepositoryCheckoutError("checkout_repository_invalid");
  }

  const root = resolve(input.cacheRoot);
  const mirror = join(root, `${input.repository.replace("/", "__")}.git`);
  const worktree = join(root, "worktrees", `${input.repository.replace("/", "__")}-${input.headSha}`);
  await mkdir(root, { recursive: true });

  const initialised = await runGit(["rev-parse", "--git-dir"], mirror);
  if (initialised.exitCode !== 0) {
    await mkdir(mirror, { recursive: true });
    const created = await runGit(["init", "--bare", "-q"], mirror);
    if (created.exitCode !== 0) throw new RepositoryCheckoutError("checkout_fetch_failed");
  }

  const remote = input.remoteUrl ?? `https://github.com/${input.repository}.git`;
  const fetched = await runGit(
    [
      "fetch", "--quiet", "--no-tags", "--prune", "--force", remote,
      "+refs/heads/*:refs/remotes/origin/*",
      "+refs/pull/*/head:refs/remotes/pull/*",
    ],
    mirror,
    authorizationConfiguration(input.token),
  );
  if (fetched.exitCode !== 0) throw new RepositoryCheckoutError("checkout_fetch_failed");

  const present = await runGit(["cat-file", "-e", `${input.headSha}^{commit}`], mirror);
  if (present.exitCode !== 0) throw new RepositoryCheckoutError("checkout_head_mismatch");

  // A leftover worktree from an interrupted run would be reused as-is, so it is
  // always removed first: preflight must observe the head, not a residue.
  await rm(worktree, { recursive: true, force: true });
  await runGit(["worktree", "prune"], mirror);

  const added = await runGit(
    ["worktree", "add", "--detach", "--force", worktree, input.headSha],
    mirror,
  );
  if (added.exitCode !== 0) throw new RepositoryCheckoutError("checkout_worktree_failed");

  const release = async (): Promise<void> => {
    await runGit(["worktree", "remove", "--force", worktree], mirror);
    await rm(worktree, { recursive: true, force: true });
  };

  const head = await runGit(["rev-parse", "--verify", "HEAD"], worktree);
  if (head.exitCode !== 0 || head.stdout.trim() !== input.headSha) {
    await release();
    throw new RepositoryCheckoutError("checkout_head_mismatch");
  }

  const status = await runGit(
    ["status", "--porcelain=v1", "--untracked-files=all"],
    worktree,
  );
  if (status.exitCode !== 0 || status.stdout.length !== 0) {
    await release();
    throw new RepositoryCheckoutError("checkout_worktree_unclean");
  }

  return { path: worktree, release };
}
