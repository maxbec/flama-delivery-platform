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

async function runSmallProcess(command: string, args: readonly string[], cwd: string): Promise<ProcessResult> {
  return new Promise((resolveProcess) => {
    const child = spawn(command, [...args], {
      cwd,
      env: { PATH: process.env["PATH"] },
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

async function runDeliveryCommand(
  entrypoint: string,
  argument: "buildable" | "affected",
  cwd: string,
): Promise<PreflightCommandResult> {
  const started = Date.now();
  const stdoutHash = createHash("sha256");
  const stderrHash = createHash("sha256");
  let outputBytes = 0;
  let outputLimitExceeded = false;
  const exitCode = await new Promise<number>((resolveProcess) => {
    const child = spawn(entrypoint, [argument], {
      cwd,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => child.kill("SIGTERM"), 20 * 60 * 1_000);
    const consume = (streamId: number, chunk: Buffer) => {
      (streamId === 1 ? stdoutHash : stderrHash).update(chunk);
      outputBytes += chunk.byteLength;
      if (outputBytes > 50 * 1_024 * 1_024 && !outputLimitExceeded) {
        outputLimitExceeded = true;
        child.kill("SIGTERM");
      }
    };
    child.stdout.on("data", (chunk: Buffer) => consume(1, chunk));
    child.stderr.on("data", (chunk: Buffer) => consume(2, chunk));
    child.once("error", () => {
      clearTimeout(timeout);
      resolveProcess(127);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (outputLimitExceeded) resolveProcess(125);
      else resolveProcess(signal === null && code !== null ? Math.min(255, Math.max(0, code)) : 124);
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

export async function runPreflight(
  input: PreflightRunInput,
  workingDirectory: string,
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

  const startedAt = new Date().toISOString();
  const commands: PreflightCommandResult[] = [];
  const buildable = await runDeliveryCommand(entrypoint, "buildable", root);
  commands.push(buildable);
  if (buildable.status === "passed") {
    commands.push(await runDeliveryCommand(entrypoint, "affected", root));
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
