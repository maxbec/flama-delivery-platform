import { spawn } from "node:child_process";
import { appendFile, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  assertSafeOutputRoot,
  assertSafeParents,
  renderTemplates,
  type RenderInput,
  type RenderResult,
} from "./render.js";

const maximumGitOutputBytes = 1024 * 1024;
const maximumAgentsBytes = 10 * 1024 * 1024;
const agentsStartMarker = "<!-- flama-delivery:start -->";
const agentsEndMarker = "<!-- flama-delivery:end -->";

type PaperclipCompany = "Private" | "// Navigaite" | "Edilio";
type BootstrapErrorCode =
  | "bootstrap_contract_mismatch"
  | "bootstrap_dirty_worktree"
  | "bootstrap_invalid_agents_file"
  | "bootstrap_not_git_root"
  | "bootstrap_repository_mismatch"
  | "bootstrap_repository_state_unavailable"
  | "bootstrap_scope_denied"
  | "bootstrap_stale_base"
  | "bootstrap_stale_source";

export interface DeliveryContract {
  readonly schemaVersion: 1;
  readonly repository: {
    readonly owner: "maxbec" | "navigaite" | "edilio";
    readonly name: string;
    readonly visibility: "private" | "public";
  };
  readonly paperclip: {
    readonly company: PaperclipCompany;
    readonly projectId: string;
    readonly workspaceId: string;
  };
  readonly profile: "fast" | "major";
  readonly branches: {
    readonly default: "main" | "dev";
    readonly stable: "main";
    readonly featureTarget: "main" | "dev";
  };
  readonly commands: Readonly<
    Record<"buildable" | "affected" | "full" | "smoke" | "health", string>
  >;
  readonly changeDetection: {
    readonly failClosed: true;
    readonly broadenOn: readonly string[];
  };
  readonly release: {
    readonly enabled: boolean;
    readonly strategy: "release-please";
    readonly impactSource: "paperclip_task";
    readonly type: RenderInput["release"]["type"];
  };
  readonly deployment: {
    readonly deployable: boolean;
    readonly provider: string;
    readonly manifestPath: ".deploy/production.yaml";
  };
  readonly secrets: {
    readonly source: "infisical";
    readonly projectSlug: string;
    readonly paths: Readonly<Record<string, string>>;
    readonly exceptionsFile: ".flama/secret-exceptions.json";
  };
  readonly platform: {
    readonly repository: "maxbec/flama-delivery-platform";
    readonly version: string;
  };
}

export interface BootstrapInput {
  /** Exact generated paths a legacy delivery system owns that may be replaced. */
  readonly replaceExisting?: readonly string[];
  readonly schemaVersion: 1;
  readonly repository: {
    readonly nameWithOwner: string;
    readonly disposition: "in_scope";
    readonly mutationAllowed: true;
    readonly isFork: false;
    readonly isArchived: false;
  };
  readonly baseSha: string;
  readonly sourceBranch: "main" | "dev";
  readonly contract: DeliveryContract;
  readonly render: RenderInput;
}

export type BootstrapOwnedStatus = "planned" | "created" | "append_planned" | "appended" | "preserved";

export interface BootstrapResult {
  readonly schemaVersion: 1;
  readonly status: "planned" | "prepared";
  readonly baseSha: string;
  readonly sourceBranch: "main" | "dev";
  readonly generated: RenderResult;
  readonly repositoryOwned: readonly {
    readonly path: string;
    readonly status: BootstrapOwnedStatus;
  }[];
}

interface BootstrapOptions {
  readonly repositoryRoot: string;
  readonly outputRoot: string;
  readonly input: BootstrapInput;
  readonly dryRun: boolean;
}

interface OwnedTarget {
  readonly path: string;
  readonly content: string;
  readonly mode: number;
  readonly appendToExisting?: true;
  /**
   * Written before the block when the file does not exist yet. A markdown file
   * whose first line is not a top-level heading fails markdownlint MD041, and a
   * second one fails MD025 — so the title belongs to the created file, never to
   * the block that is appended to a file that already has its own.
   */
  readonly createPrefix?: string;
  /** Marker pair proving this block is already present, for appendable files. */
  readonly markers?: readonly [string, string];
  /**
   * Merge the generated paths into a Trunk lint-ignore block instead of writing
   * a file. Trunk resolves its own ignores from this configuration and never
   * consults a formatter ignore file, so nothing else reaches its checks.
   */
  readonly mergeTrunkIgnore?: readonly string[];
}

interface OwnedState {
  readonly target: OwnedTarget;
  readonly exists: boolean;
  readonly append: boolean;
  readonly originalContent?: string;
}

export class BootstrapError extends Error {
  override readonly name = "BootstrapError";

  constructor(readonly code: BootstrapErrorCode) {
    super(code);
  }
}

function jsonFile(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function ownerCompany(owner: string): PaperclipCompany | undefined {
  switch (owner) {
    case "maxbec":
      return "Private";
    case "navigaite":
      return "// Navigaite";
    case "edilio-app":
      return "Edilio";
    default:
      return undefined;
  }
}

function assertInputConsistency(input: BootstrapInput): void {
  const repositoryState = input.repository as {
    readonly disposition: string;
    readonly mutationAllowed: boolean;
    readonly isFork: boolean;
    readonly isArchived: boolean;
  };
  if (
    repositoryState.disposition !== "in_scope" ||
    !repositoryState.mutationAllowed ||
    repositoryState.isFork ||
    repositoryState.isArchived
  ) {
    throw new BootstrapError("bootstrap_scope_denied");
  }
  const [owner, repositoryName, extra] = input.repository.nameWithOwner.split("/");
  const expectedBranch = input.render.profile === "major" ? "dev" : "main";
  if (
    extra !== undefined ||
    owner === undefined ||
    repositoryName === undefined ||
    ownerCompany(owner) !== input.contract.paperclip.company ||
    input.contract.repository.owner !== owner ||
    input.contract.repository.name !== repositoryName ||
    input.render.repository !== input.repository.nameWithOwner ||
    input.render.paperclip.company !== input.contract.paperclip.company ||
    input.render.paperclip.projectId !== input.contract.paperclip.projectId ||
    input.render.paperclip.workspaceId !== input.contract.paperclip.workspaceId ||
    input.render.profile !== input.contract.profile ||
    input.sourceBranch !== expectedBranch ||
    input.contract.branches.default !== input.sourceBranch ||
    input.render.platformVersion !== input.contract.platform.version ||
    input.render.release.enabled !== input.contract.release.enabled ||
    input.render.release.type !== input.contract.release.type
  ) {
    throw new BootstrapError("bootstrap_contract_mismatch");
  }
}

function githubRepositoryFromRemote(remote: string): string | undefined {
  const scpMatch = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/u.exec(remote);
  if (scpMatch?.[1] !== undefined) return scpMatch[1];
  try {
    const parsed = new URL(remote);
    if (parsed.hostname !== "github.com") return undefined;
    const repository = parsed.pathname.replace(/^\//u, "").replace(/\.git$/u, "");
    return /^[^/]+\/[^/]+$/u.test(repository) ? repository : undefined;
  } catch {
    return undefined;
  }
}

async function runGit(root: string, args: readonly string[]): Promise<string> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("git", ["-C", root, ...args], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    const reject = (): void => {
      if (rejected) return;
      rejected = true;
      child.kill("SIGKILL");
      rejectRun(new BootstrapError("bootstrap_repository_state_unavailable"));
    };
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maximumGitOutputBytes) reject();
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maximumGitOutputBytes) reject();
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (rejected) return;
      if (signal !== null || code !== 0) reject();
      else resolveRun(Buffer.concat(chunks).toString("utf8").trim());
    });
  });
}

async function assertRepositoryState(root: string, input: BootstrapInput): Promise<void> {
  const topLevel = await runGit(root, ["rev-parse", "--show-toplevel"]);
  if ((await realpath(topLevel)) !== root) throw new BootstrapError("bootstrap_not_git_root");
  const remote = await runGit(root, ["remote", "get-url", "origin"]);
  if (githubRepositoryFromRemote(remote) !== input.repository.nameWithOwner) {
    throw new BootstrapError("bootstrap_repository_mismatch");
  }
  if ((await runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).length > 0) {
    throw new BootstrapError("bootstrap_dirty_worktree");
  }
  if ((await runGit(root, ["rev-parse", "HEAD"])) !== input.baseSha) {
    throw new BootstrapError("bootstrap_stale_base");
  }
  if (
    (await runGit(root, ["rev-parse", `refs/remotes/origin/${input.sourceBranch}`])) !==
    input.baseSha
  ) {
    throw new BootstrapError("bootstrap_stale_source");
  }
}

function agentsBlock(input: BootstrapInput): string {
  const stableBoundary = input.render.profile === "major" ? "dev for feature work and main for promotion" : "main";
  return [
    "<!-- prettier-ignore-start -->",
    agentsStartMarker,
    "## Flama delivery",
    "",
    `This repository uses the ${input.render.profile} delivery profile. Target ${stableBoundary}.`,
    "Run deterministic checks only through `./scripts/delivery`.",
    "Never expose secret values; use the approved Infisical identity and paths.",
    "Production requires Max's approval of the exact deployment PR head SHA.",
    "Do not edit centrally generated `.flama` or Flama workflow files by hand.",
    agentsEndMarker,
    "<!-- prettier-ignore-end -->",
    "",
  ].join("\n");
}

// A repository whose formatting is driven by Trunk keeps its prettier ignore
// list beside its other linter configuration, and a root-level file is never
// read. The location is discovered from the repository rather than assumed.
async function prettierIgnorePath(outputRoot: string): Promise<string> {
  for (const candidate of [".trunk/configs/.prettierignore", "configs/.prettierignore"]) {
    try {
      await lstat(join(outputRoot, candidate));
      return candidate;
    } catch {
      continue;
    }
  }
  return ".prettierignore";
}

const generatedExclusions = [
  ".flama/**",
  ".paperclip/**",
  ".github/workflows/flama-*.yml",
  ".github/dependabot.yml",
  ".github/CODEOWNERS",
  ".release-please-config.json",
  ".release-please-manifest.json",
  "scripts/delivery",
];

// Generated files are platform-owned and drift-protected: a consumer formatter
// that rewrote them would fight the platform on every run. Where the repository
// uses Trunk the exclusion has to live in its lint configuration, because Trunk
// resolves its own ignores and never reads a formatter ignore file.
async function formatterExclusionTarget(outputRoot: string): Promise<OwnedTarget> {
  try {
    await lstat(join(outputRoot, ".trunk/trunk.yaml"));
    return {
      path: ".trunk/trunk.yaml",
      content: "",
      mode: 0o644,
      mergeTrunkIgnore: generatedExclusions,
    };
  } catch {
    return {
      path: await prettierIgnorePath(outputRoot),
      appendToExisting: true as const,
      markers: ["# flama-delivery:start", "# flama-delivery:end"] as const,
      content: [
        "",
        "# flama-delivery:start",
        "# Flama delivery platform: generated and drift-protected.",
        ...generatedExclusions.map((path) => path.replace("/**", "/")),
        "# flama-delivery:end",
        "",
      ].join("\n"),
      mode: 0o644,
    };
  }
}

async function ownedTargets(
  repositoryRoot: string,
  input: BootstrapInput,
  outputRoot: string,
): Promise<readonly OwnedTarget[]> {
  const common = join(repositoryRoot, "templates", "common");
  return [
    {
      path: ".flama/commands.json",
      content: jsonFile(input.render.commands),
      mode: 0o644,
    },
    {
      path: ".flama/delivery-contract.json",
      content: jsonFile(input.contract),
      mode: 0o644,
    },
    {
      path: ".flama/run-command.mjs",
      content: await readFile(join(common, ".flama", "run-command.mjs"), "utf8"),
      mode: 0o644,
    },
    {
      path: ".paperclip/project.yaml",
      content: stringifyYaml(
        {
          schemaVersion: 1,
          repository: input.repository.nameWithOwner,
          company: input.contract.paperclip.company,
          projectId: input.contract.paperclip.projectId,
          workspaceId: input.contract.paperclip.workspaceId,
          profile: input.contract.profile,
        },
        { lineWidth: 0 },
      ),
      mode: 0o644,
    },
    await formatterExclusionTarget(outputRoot),
    {
      path: "AGENTS.md",
      content: agentsBlock(input),
      mode: 0o644,
      appendToExisting: true as const,
      createPrefix: "# Agent instructions\n\n",
    },
    {
      path: "scripts/delivery",
      content: await readFile(join(common, "scripts", "delivery"), "utf8"),
      mode: 0o755,
    },
  ].sort((left, right) => left.path.localeCompare(right.path));
}

function markerCount(content: string, marker: string): number {
  return content.split(marker).length - 1;
}

async function planOwnedTargets(
  root: string,
  targets: readonly OwnedTarget[],
): Promise<readonly OwnedState[]> {
  const states: OwnedState[] = [];
  for (const target of targets) {
    const destination = join(root, target.path);
    await assertSafeParents(root, destination);
    try {
      const metadata = await lstat(destination);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new BootstrapError("bootstrap_repository_state_unavailable");
      }
      if (target.appendToExisting !== true) {
        states.push({ target, exists: true, append: false });
        continue;
      }
      if (metadata.size > maximumAgentsBytes) {
        throw new BootstrapError("bootstrap_invalid_agents_file");
      }
      const originalContent = await readFile(destination, "utf8");
      const [startMarker, endMarker] = target.markers ?? [agentsStartMarker, agentsEndMarker];
      const startCount = markerCount(originalContent, startMarker);
      const endCount = markerCount(originalContent, endMarker);
      if (startCount === 0 && endCount === 0) {
        states.push({ target, exists: true, append: true, originalContent });
      } else if (
        startCount === 1 &&
        endCount === 1 &&
        originalContent.indexOf(startMarker) < originalContent.indexOf(endMarker)
      ) {
        states.push({ target, exists: true, append: false });
      } else {
        throw new BootstrapError("bootstrap_invalid_agents_file");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      states.push({ target, exists: false, append: false });
    }
  }
  return states;
}

function appendPrefix(originalContent: string): string {
  if (originalContent.length === 0) return "";
  return originalContent.endsWith("\n") ? "\n" : "\n\n";
}

// Trunk's own wildcard. An enumerated list silently omits whatever linter the
// repository adds next — a generated `.mjs` was being linted by eslint because
// eslint was not on the list.
const trunkIgnoreLinters = ["ALL"];

/**
 * Add our ignore entry to a Trunk configuration the repository owns.
 *
 * The edit is textual. Parsing and re-stringifying the document produces valid
 * YAML but drops every comment and the leading `---`, which destroys
 * documentation nobody asked us to touch and leaves a file yamllint then fails.
 * The document is still parsed, but only to decide whether the entry is already
 * present and where `lint:` sits.
 */
async function mergeTrunkIgnore(destination: string, paths: readonly string[]): Promise<void> {
  const original = await readFile(destination, "utf8");
  const document = (parseYaml(original) ?? {}) as Record<string, unknown>;
  const lint = (document["lint"] ?? {}) as Record<string, unknown>;
  const ignore = Array.isArray(lint["ignore"]) ? (lint["ignore"] as unknown[]) : [];
  const already = ignore.some((entry) =>
    typeof entry === "object" && entry !== null &&
    JSON.stringify((entry as Record<string, unknown>)["paths"]) === JSON.stringify([...paths]));
  if (already) return;

  const entry = [
    `    - linters: [${trunkIgnoreLinters.join(", ")}]`,
    "      paths:",
    ...paths.map((path) => `        - ${path}`),
  ];
  const lines = original.replace(/\n$/u, "").split("\n");
  const ignoreIndex = lines.findIndex((line) => /^\s{2}ignore:\s*$/u.test(line));
  if (ignoreIndex >= 0) {
    lines.splice(ignoreIndex + 1, 0, ...entry);
  } else {
    const lintIndex = lines.findIndex((line) => /^lint:\s*$/u.test(line));
    if (lintIndex >= 0) {
      lines.splice(lintIndex + 1, 0, "  ignore:", ...entry);
    } else {
      lines.push("lint:", "  ignore:", ...entry);
    }
  }
  await writeFile(destination, `${lines.join("\n")}\n`, "utf8");
}

async function applyOwnedTargets(root: string, states: readonly OwnedState[]): Promise<void> {
  for (const state of states) {
    const destination = join(root, state.target.path);
    if (state.target.mergeTrunkIgnore !== undefined) {
      await mergeTrunkIgnore(destination, state.target.mergeTrunkIgnore);
      continue;
    }
    if (state.append) {
      const currentContent = await readFile(destination, "utf8");
      if (currentContent !== state.originalContent) {
        throw new BootstrapError("bootstrap_repository_state_unavailable");
      }
      await appendFile(destination, `${appendPrefix(currentContent)}${state.target.content}`, "utf8");
    } else if (!state.exists) {
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, `${state.target.createPrefix ?? ""}${state.target.content}`, {
        encoding: "utf8",
        flag: "wx",
        mode: state.target.mode,
      });
    }
  }
}

function ownedStatus(state: OwnedState, dryRun: boolean): BootstrapOwnedStatus {
  if (state.append) return dryRun ? "append_planned" : "appended";
  if (state.exists) return "preserved";
  return dryRun ? "planned" : "created";
}

export async function bootstrapRepository(options: BootstrapOptions): Promise<BootstrapResult> {
  assertInputConsistency(options.input);
  const root = await assertSafeOutputRoot(options.outputRoot);
  await assertRepositoryState(root, options.input);

  const generatedPlan = await renderTemplates({
    repositoryRoot: options.repositoryRoot,
    outputRoot: root,
    input: options.input.render,
    dryRun: true,
    ...(options.input.replaceExisting === undefined
      ? {}
      : { replaceExisting: options.input.replaceExisting }),
  });
  const owned = await planOwnedTargets(root, await ownedTargets(options.repositoryRoot, options.input, root));

  const generated = options.dryRun
    ? generatedPlan
    : await renderTemplates({
        repositoryRoot: options.repositoryRoot,
        outputRoot: root,
        input: options.input.render,
        dryRun: false,
        ...(options.input.replaceExisting === undefined
          ? {}
          : { replaceExisting: options.input.replaceExisting }),
      });
  if (!options.dryRun) await applyOwnedTargets(root, owned);

  return {
    schemaVersion: 1,
    status: options.dryRun ? "planned" : "prepared",
    baseSha: options.input.baseSha,
    sourceBranch: options.input.sourceBranch,
    generated,
    repositoryOwned: owned.map((state) => ({
      path: state.target.path,
      status: ownedStatus(state, options.dryRun),
    })),
  };
}
