import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { collectGovernance, parseGovernanceInput, type GovernanceInput } from "./governance.js";
import { createGovernanceReaders } from "./readers.js";

type Environment = Readonly<Record<string, string | undefined>>;
type FetchImplementation = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface GovernanceRuntimeIo {
  writeStdout(value: string): void;
  writeStderr(value: string): void;
}

const maximumInputBytes = 10 * 1024 * 1024;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(
      ([key, nested]) => [key, stableValue(nested)],
    ));
  }
  return value;
}

async function readPrivateInput(path: string): Promise<unknown> {
  const metadata = await lstat(path);
  if (
    !metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumInputBytes ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new Error("input rejected");
  }
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function verifyNativeControllerAttestations(
  input: GovernanceInput,
  directory: string | undefined,
): Promise<void> {
  if (
    directory === undefined || directory.length === 0 || directory.length > 4_096 ||
    /[\r\n\u0000]/u.test(directory) || !isAbsolute(directory) || normalize(directory) !== directory
  ) throw new Error("attestation directory rejected");
  const [metadata, canonical] = await Promise.all([lstat(directory), realpath(directory)]);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || canonical !== directory) {
    throw new Error("attestation directory rejected");
  }

  for (const scope of input.scopes) {
    const path = join(directory, `paperclip-governance-${scope.paperclipAttestation.runId}.json`);
    const file = await lstat(path);
    if (
      !file.isFile() || file.isSymbolicLink() || file.size > 64 * 1024 ||
      (file.mode & 0o077) !== 0
    ) throw new Error("attestation evidence rejected");
    const observed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (JSON.stringify(stableValue(observed)) !== JSON.stringify(stableValue(scope.paperclipAttestation))) {
      throw new Error("attestation evidence rejected");
    }
  }
}

async function writePrivateEvidence(path: string, value: unknown): Promise<string> {
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("output rejected");
  const source = `${JSON.stringify(stableValue(value), null, 2)}\n`;
  const digest = `sha256:${createHash("sha256").update(source).digest("hex")}`;
  await writeFile(path, source, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return digest;
}

export async function runGovernanceRuntime(
  argv: readonly string[],
  environment: Environment,
  io: GovernanceRuntimeIo,
  fetchImplementation: FetchImplementation = fetch,
): Promise<number> {
  let inputPath: string | undefined;
  let outputPath: string | undefined;
  try {
    const parsed = parseArgs({
      args: [...argv],
      options: { input: { type: "string" }, output: { type: "string" } },
      allowPositionals: false,
      strict: true,
    });
    inputPath = parsed.values.input;
    outputPath = parsed.values.output;
  } catch {
    io.writeStderr('{"status":"failed","reason":"governance_runtime_failure"}\n');
    return 1;
  }
  if (inputPath === undefined || outputPath === undefined) {
    io.writeStderr('{"status":"failed","reason":"governance_runtime_failure"}\n');
    return 1;
  }
  try {
    const input = parseGovernanceInput(await readPrivateInput(inputPath));
    await verifyNativeControllerAttestations(input, environment["FLAMA_RECONCILIATION_EVIDENCE_DIR"]);
    const result = await collectGovernance(input, createGovernanceReaders(environment, fetchImplementation));
    const digest = await writePrivateEvidence(outputPath, result);
    io.writeStdout(`${JSON.stringify({ status: "collected", digest })}\n`);
    return 0;
  } catch {
    io.writeStderr('{"status":"failed","reason":"governance_runtime_failure"}\n');
    return 1;
  }
}

async function main(): Promise<void> {
  process.exitCode = await runGovernanceRuntime(process.argv.slice(2), process.env, {
    writeStdout(value) {
      process.stdout.write(value);
    },
    writeStderr(value) {
      process.stderr.write(value);
    },
  });
}

const invokedPath = process.argv[1];
let invokedDirectly = false;
if (invokedPath !== undefined) {
  try {
    invokedDirectly = realpathSync(invokedPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    invokedDirectly = false;
  }
}
if (invokedDirectly) await main();
