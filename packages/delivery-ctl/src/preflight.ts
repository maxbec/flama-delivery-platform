import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface PreflightRunInput {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly releaseImpact: "none" | "patch" | "minor" | "major";
}

export interface PreflightCommandResult {
  readonly command: "./scripts/delivery buildable" | "./scripts/delivery affected";
  readonly status: "passed" | "failed";
  readonly exitCode: number;
  readonly durationMilliseconds: number;
  readonly outputBytes: number;
  readonly evidenceDigest: string;
}

export interface PreflightRunResult {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly runnerClass: "paperclip_ephemeral";
  readonly releaseImpact: "none" | "patch" | "minor" | "major";
  readonly status: "passed" | "failed";
  readonly commands: readonly PreflightCommandResult[];
}

export type PreflightErrorCode =
  | "delivery_entrypoint_invalid"
  | "head_sha_mismatch"
  | "input_invalid"
  | "source_sha_missing"
  | "worktree_not_clean";

export class PreflightError extends Error {
  constructor(readonly code: PreflightErrorCode) {
    super("preflight rejected");
    this.name = "PreflightError";
  }
}

interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
}

/**
 * How long to wait after `exit` for the child's pipes to close.
 *
 * `exit` fires when the process is gone, `close` when its output has actually
 * been drained — reading a result at `exit` can therefore read a truncated one.
 * Waiting for `close` alone is not safe either: a grandchild inheriting the
 * pipes keeps them open after the child is dead, and a killed delivery command
 * is exactly when that happens, so `close` might never arrive.
 */
const outputDrainMilliseconds = 5_000;

/**
 * How long a command gets to exit on its own after SIGTERM before SIGKILL.
 *
 * SIGTERM is a request, and a delivery command is arbitrary code that may
 * ignore it — a test runner installing a handler, or a shell that never
 * forwards it. Without escalation the ceiling enforces nothing and the pass
 * waits forever on a process that already refused to stop.
 */
const terminationGraceMilliseconds = 10_000;

async function runSmallProcess(command: string, args: readonly string[], cwd: string): Promise<ProcessResult> {
  return new Promise((resolveProcess) => {
    const child = spawn(command, [...args], {
      cwd,
      env: { PATH: process.env["PATH"] },
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    let settled = false;
    const settle = (result: ProcessResult) => {
      if (settled) return;
      settled = true;
      resolveProcess(result);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length <= 1_048_576) stdout += chunk;
    });
    const finish = (code: number | null, signal: NodeJS.Signals | null) =>
      settle({ exitCode: signal === null && code !== null ? code : 124, stdout });
    child.once("error", () => settle({ exitCode: 127, stdout: "" }));
    child.once("close", finish);
    child.once("exit", (code, signal) => {
      setTimeout(() => finish(code, signal), outputDrainMilliseconds).unref();
    });
  });
}

/**
 * A delivery command is a CI job's worth of work — the ceiling is sized for
 * one, and a caller that has less time than that says so.
 */
const defaultCommandTimeoutMilliseconds = 20 * 60 * 1_000;

async function runDeliveryCommand(
  entrypoint: string,
  argument: "buildable" | "affected",
  cwd: string,
  timeoutMilliseconds: number,
): Promise<PreflightCommandResult> {
  const started = Date.now();
  const stdoutHash = createHash("sha256");
  const stderrHash = createHash("sha256");
  let outputBytes = 0;
  let outputLimitExceeded = false;
  // The hashes are finalised once the run settles, and a chunk arriving after
  // that would throw ERR_CRYPTO_HASH_FINALIZED out of an event handler — an
  // uncatchable crash of the whole controller, not a failed preflight. Output
  // after settling is normal here: a killed command's pipes drain afterwards.
  let outputClosed = false;
  const exitCode = await new Promise<number>((resolveProcess) => {
    const child = spawn(entrypoint, [argument], {
      cwd,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let escalation: NodeJS.Timeout | undefined;
    const terminate = () => {
      child.kill("SIGTERM");
      escalation ??= setTimeout(() => child.kill("SIGKILL"), terminationGraceMilliseconds).unref();
    };
    const timeout = setTimeout(terminate, timeoutMilliseconds);
    let settled = false;
    const settle = (code: number) => {
      if (settled) return;
      settled = true;
      outputClosed = true;
      clearTimeout(timeout);
      if (escalation !== undefined) clearTimeout(escalation);
      resolveProcess(code);
    };
    const consume = (streamId: number, chunk: Buffer) => {
      if (outputClosed) return;
      (streamId === 1 ? stdoutHash : stderrHash).update(chunk);
      outputBytes += chunk.byteLength;
      if (outputBytes > 50 * 1_024 * 1_024 && !outputLimitExceeded) {
        outputLimitExceeded = true;
        terminate();
      }
    };
    child.stdout.on("data", (chunk: Buffer) => consume(1, chunk));
    child.stderr.on("data", (chunk: Buffer) => consume(2, chunk));
    child.once("error", () => settle(127));
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (outputLimitExceeded) settle(125);
      else settle(signal === null && code !== null ? Math.min(255, Math.max(0, code)) : 124);
    };
    // `close` carries the drained output the evidence digest is taken over;
    // the timer is the escape hatch for pipes a grandchild holds open.
    child.once("close", finish);
    child.once("exit", (code, signal) => {
      setTimeout(() => finish(code, signal), outputDrainMilliseconds).unref();
    });
  });
  const evidenceHash = createHash("sha256");
  evidenceHash.update(`./scripts/delivery ${argument}\0`);
  evidenceHash.update(stdoutHash.digest());
  evidenceHash.update(stderrHash.digest());
  return {
    command: `./scripts/delivery ${argument}`,
    status: exitCode === 0 ? "passed" : "failed",
    exitCode,
    durationMilliseconds: Math.max(0, Date.now() - started),
    outputBytes: Math.min(outputBytes, 50 * 1_024 * 1_024),
    evidenceDigest: `sha256:${evidenceHash.digest("hex")}`,
  };
}

function validateInput(input: PreflightRunInput): void {
  if (
    input.schemaVersion !== 1 ||
    !/^(?:maxbec|navigaite|edilio-app)\/[A-Za-z0-9._-]+$/u.test(input.repository) ||
    !/^[0-9a-f]{40}$/u.test(input.headSha) || !/^[0-9a-f]{40}$/u.test(input.baseSha) ||
    !(["none", "patch", "minor", "major"] as const).includes(input.releaseImpact)
  ) throw new PreflightError("input_invalid");
}

export interface RunPreflightOptions {
  /**
   * Ceiling for each delivery command. A caller running inside a shorter
   * window than a CI job passes its own; a command killed here fails the
   * preflight, which is the correct verdict — an unfinished command has not
   * demonstrated anything.
   */
  readonly commandTimeoutMilliseconds?: number;
}

export async function runPreflight(
  input: PreflightRunInput,
  workingDirectory: string,
  options: RunPreflightOptions = {},
): Promise<PreflightRunResult> {
  validateInput(input);
  const root = await realpath(resolve(workingDirectory));
  const head = await runSmallProcess("git", ["rev-parse", "--verify", "HEAD"], root);
  if (head.exitCode !== 0) throw new PreflightError("source_sha_missing");
  if (head.stdout.trim() !== input.headSha) throw new PreflightError("head_sha_mismatch");
  const base = await runSmallProcess("git", ["cat-file", "-e", `${input.baseSha}^{commit}`], root);
  if (base.exitCode !== 0) throw new PreflightError("source_sha_missing");
  const worktree = await runSmallProcess(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    root,
  );
  if (worktree.exitCode !== 0 || worktree.stdout.length !== 0) {
    throw new PreflightError("worktree_not_clean");
  }

  const scriptsDirectory = join(root, "scripts");
  const entrypoint = join(scriptsDirectory, "delivery");
  try {
    const [directoryMetadata, entrypointMetadata] = await Promise.all([
      lstat(scriptsDirectory),
      lstat(entrypoint),
    ]);
    if (
      !directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink() ||
      !entrypointMetadata.isFile() || entrypointMetadata.isSymbolicLink() ||
      (entrypointMetadata.mode & 0o111) === 0
    ) throw new PreflightError("delivery_entrypoint_invalid");
  } catch (error) {
    if (error instanceof PreflightError) throw error;
    throw new PreflightError("delivery_entrypoint_invalid");
  }

  const commandTimeout = options.commandTimeoutMilliseconds ?? defaultCommandTimeoutMilliseconds;
  const startedAt = new Date().toISOString();
  const commands: PreflightCommandResult[] = [];
  const buildable = await runDeliveryCommand(entrypoint, "buildable", root, commandTimeout);
  commands.push(buildable);
  if (buildable.status === "passed") {
    commands.push(await runDeliveryCommand(entrypoint, "affected", root, commandTimeout));
  }
  const status = commands.length === 2 && commands.every((command) => command.status === "passed")
    ? "passed"
    : "failed";
  return {
    schemaVersion: 1,
    repository: input.repository,
    headSha: input.headSha,
    baseSha: input.baseSha,
    startedAt,
    finishedAt: new Date().toISOString(),
    runnerClass: "paperclip_ephemeral",
    releaseImpact: input.releaseImpact,
    status,
    commands,
  };
}
