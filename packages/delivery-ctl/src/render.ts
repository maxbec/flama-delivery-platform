import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Scalar, stringify as stringifyYaml } from "yaml";

export type DependabotEcosystem =
  | "npm"
  | "pip"
  | "composer"
  | "docker"
  | "github-actions"
  | "pub"
  | "gomod"
  | "gradle"
  | "maven"
  | "cargo";

export interface DependabotEntry {
  readonly packageEcosystem: DependabotEcosystem;
  readonly directory: string;
}

export interface RenderInput {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly profile: "fast" | "major";
  readonly platformRef: string;
  readonly platformVersion: string;
  readonly paperclip: {
    readonly company: "Private" | "// Navigaite" | "Edilio";
    readonly projectId: string;
    readonly workspaceId: string;
    readonly appSlug: string;
  };
  readonly release: {
    readonly enabled: boolean;
    readonly type: "node" | "python" | "php" | "flutter" | "go" | "simple";
    readonly currentVersion: string;
  };
  readonly dependabot: { readonly ecosystems: readonly DependabotEntry[] };
  readonly commands: Readonly<Record<"buildable" | "affected" | "full" | "smoke" | "health", readonly string[]>>;
}

export type RenderStatus = "planned" | "created" | "unchanged" | "replaced";

export interface RenderResult {
  readonly schemaVersion: 1;
  readonly profile: "fast" | "major";
  readonly platformRef: string;
  readonly files: readonly { readonly path: string; readonly status: RenderStatus }[];
}

interface RenderOptions {
  readonly repositoryRoot: string;
  readonly outputRoot: string;
  readonly input: RenderInput;
  readonly dryRun: boolean;
  /**
   * Exact generated paths whose existing content this run is authorized to
   * replace. A repository already managed by an earlier delivery system is
   * migrated by naming its files here; anything unnamed still fails closed.
   */
  readonly replaceExisting?: readonly string[];
}

interface TargetFile {
  readonly path: string;
  readonly content: string;
  readonly mode: number;
}

interface DependabotPolicy {
  readonly schedule: {
    readonly interval: "weekly";
    readonly time: string;
    readonly timezone: string;
    readonly weekdayStrategy: "repository_sha256_modulo_weekdays";
  };
  readonly requiredEcosystems: readonly ["github-actions"];
  readonly openPullRequestsLimit: number;
  readonly cooldownDays: number;
  readonly groups: {
    readonly "routine-updates": { readonly updateTypes: readonly ["minor", "patch"] };
  };
}

export class RenderConflictError extends Error {
  override readonly name = "RenderConflictError";

  constructor(readonly conflicts: readonly string[]) {
    super("render targets differ from generated content");
  }
}

async function readTemplate(path: string): Promise<string> {
  return readFile(path, "utf8");
}

function jsonFile(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function loadDependabotPolicy(repositoryRoot: string): Promise<DependabotPolicy> {
  const value: unknown = JSON.parse(
    await readFile(join(repositoryRoot, "policies", "dependabot.json"), "utf8"),
  );
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid Dependabot policy");
  }
  const schedule = Reflect.get(value, "schedule");
  const requiredEcosystems = Reflect.get(value, "requiredEcosystems");
  const openPullRequestsLimit = Reflect.get(value, "openPullRequestsLimit");
  const groups = Reflect.get(value, "groups");
  if (
    typeof schedule !== "object" ||
    schedule === null ||
    Reflect.get(schedule, "interval") !== "weekly" ||
    typeof Reflect.get(schedule, "time") !== "string" ||
    typeof Reflect.get(schedule, "timezone") !== "string" ||
    Reflect.get(schedule, "weekdayStrategy") !== "repository_sha256_modulo_weekdays" ||
    !Array.isArray(requiredEcosystems) ||
    requiredEcosystems.length !== 1 ||
    requiredEcosystems[0] !== "github-actions" ||
    !Number.isInteger(openPullRequestsLimit) ||
    (openPullRequestsLimit as number) < 1 ||
    typeof groups !== "object" ||
    groups === null
  ) {
    throw new Error("invalid Dependabot policy");
  }
  const routineUpdates = Reflect.get(groups, "routine-updates");
  const updateTypes =
    typeof routineUpdates === "object" && routineUpdates !== null
      ? Reflect.get(routineUpdates, "updateTypes")
      : undefined;
  if (
    !Array.isArray(updateTypes) ||
    updateTypes.length !== 2 ||
    updateTypes[0] !== "minor" ||
    updateTypes[1] !== "patch"
  ) {
    throw new Error("invalid Dependabot policy");
  }
  return value as unknown as DependabotPolicy;
}

function dependabotWeekday(repository: string): "monday" | "tuesday" | "wednesday" | "thursday" | "friday" {
  const weekdays = ["monday", "tuesday", "wednesday", "thursday", "friday"] as const;
  const firstByte = createHash("sha256").update(repository).digest().at(0);
  if (firstByte === undefined) throw new Error("repository schedule digest is empty");
  const weekday = weekdays[firstByte % weekdays.length];
  if (weekday === undefined) throw new Error("repository schedule weekday is unavailable");
  return weekday;
}

function dependabotEntries(input: RenderInput, policy: DependabotPolicy): readonly DependabotEntry[] {
  const entries = new Map<string, DependabotEntry>();
  for (const entry of input.dependabot.ecosystems) {
    entries.set(`${entry.packageEcosystem}\u0000${entry.directory}`, entry);
  }
  for (const packageEcosystem of policy.requiredEcosystems) {
    entries.set(`${packageEcosystem}\u0000/`, { packageEcosystem, directory: "/" });
  }
  return [...entries.values()].sort(
    (left, right) =>
      left.packageEcosystem.localeCompare(right.packageEcosystem) ||
      left.directory.localeCompare(right.directory),
  );
}

function quoted(value: string): Scalar<string> {
  const scalar = new Scalar(value);
  scalar.type = Scalar.QUOTE_DOUBLE;
  return scalar;
}

function renderDependabot(input: RenderInput, policy: DependabotPolicy): string {
  const targetBranch = input.profile === "major" ? "dev" : "main";
  // Consumer repositories run yamllint, which requires an explicit start marker.
  return `---\n${stringifyYaml(
    {
      version: 2,
      updates: dependabotEntries(input, policy).map((entry) => ({
        "package-ecosystem": entry.packageEcosystem,
        directory: entry.directory,
        schedule: {
          interval: policy.schedule.interval,
          day: dependabotWeekday(input.repository),
          // Unquoted 04:00 is an integer under YAML 1.1 and Dependabot then
          // rejects the entire configuration file.
          time: quoted(policy.schedule.time),
          timezone: policy.schedule.timezone,
        },
        "target-branch": targetBranch,
        "open-pull-requests-limit": policy.openPullRequestsLimit,
        // A newly published version can be malicious or unstable, so every
        // ecosystem waits before an update is proposed.
        cooldown: { "default-days": policy.cooldownDays },
        groups: {
          "routine-updates": {
            "update-types": [...policy.groups["routine-updates"].updateTypes],
          },
        },
      })),
    },
    { lineWidth: 0 },
  )}`;
}

async function buildTargets(repositoryRoot: string, input: RenderInput): Promise<readonly TargetFile[]> {
  const profile = join(repositoryRoot, "templates", input.profile);
  const dependabotPolicy = await loadDependabotPolicy(repositoryRoot);
  const replacePlatformRef = (template: string): string => {
    const rendered = template
      .replaceAll("__FLAMA_PLATFORM_REF__", input.platformRef)
      .replaceAll("__FLAMA_PAPERCLIP_APP_SLUG__", input.paperclip.appSlug);
    if (rendered.includes("__FLAMA_")) throw new Error("unresolved template token");
    return rendered;
  };

  const targets: TargetFile[] = [
    {
      path: ".github/workflows/flama-branch-guard.yml",
      content: replacePlatformRef(
        await readTemplate(join(profile, ".github", "workflows", "flama-branch-guard.yml.tmpl")),
      ),
      mode: 0o644,
    },
    {
      path: ".github/workflows/flama-deploy.yml",
      content: replacePlatformRef(
        await readTemplate(
          join(repositoryRoot, "templates", "common", ".github", "workflows", "flama-deploy.yml.tmpl"),
        ),
      ),
      mode: 0o644,
    },
    {
      path: ".flama/paperclip-webhook.json",
      content: jsonFile({
        schemaVersion: 1,
        repository: input.repository,
        company: input.paperclip.company,
        projectId: input.paperclip.projectId,
        workspaceId: input.paperclip.workspaceId,
        appSlug: input.paperclip.appSlug,
        events: [
          "check_run",
          "deployment_status",
          "pull_request",
          "pull_request_review",
          "push",
          "release",
          "workflow_run",
        ],
      }),
      mode: 0o644,
    },
    {
      path: ".flama/platform-lock.json",
      content: jsonFile({
        schemaVersion: 1,
        repository: "maxbec/flama-delivery-platform",
        version: input.platformVersion,
        ref: input.platformRef,
      }),
      mode: 0o644,
    },
    {
      path: ".github/CODEOWNERS",
      content: [
        "/.deploy/production.yaml @maxbec",
        "/.flama/paperclip-webhook.json @maxbec",
        "/.flama/platform-lock.json @maxbec",
        "/.github/dependabot.yml @maxbec",
        "/.github/workflows/flama-*.yml @maxbec",
        "/.release-please-config.json @maxbec",
        "/.release-please-manifest.json @maxbec",
        "",
      ].join("\n"),
      mode: 0o644,
    },
    {
      path: ".github/dependabot.yml",
      content: renderDependabot(input, dependabotPolicy),
      mode: 0o644,
    },
    {
      path: ".github/workflows/flama-final.yml",
      content: replacePlatformRef(
        await readTemplate(join(profile, ".github", "workflows", "flama-final.yml.tmpl")),
      ),
      mode: 0o644,
    },
    {
      path: ".github/workflows/flama-policy.yml",
      content: replacePlatformRef(
        await readTemplate(join(profile, ".github", "workflows", "flama-policy.yml.tmpl")),
      ),
      mode: 0o644,
    },
  ];

  if (input.release.enabled) {
    targets.push(
      {
        path: ".release-please-config.json",
        content: jsonFile({
          packages: {
            ".": {
              "release-type": input.release.type,
              "include-component-in-tag": false,
            },
          },
        }),
        mode: 0o644,
      },
      {
        path: ".release-please-manifest.json",
        content: jsonFile({ ".": input.release.currentVersion }),
        mode: 0o644,
      },
    );
  }

  return targets.sort((left, right) => left.path.localeCompare(right.path));
}

export async function assertSafeOutputRoot(outputRoot: string): Promise<string> {
  const root = resolve(outputRoot);
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("output root must be a real directory");
  }
  return realpath(root);
}

export async function assertSafeParents(root: string, targetPath: string): Promise<void> {
  const parent = dirname(targetPath);
  const relativeParent = relative(root, parent);
  if (relativeParent.startsWith(`..${sep}`) || relativeParent === "..") {
    throw new Error("render target escaped output root");
  }
  let current = root;
  for (const component of relativeParent.split(sep).filter(Boolean)) {
    current = join(current, component);
    try {
      const metadata = await lstat(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error("render parent is not a real directory");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

export async function renderTemplates(options: RenderOptions): Promise<RenderResult> {
  const root = await assertSafeOutputRoot(options.outputRoot);
  const targets = await buildTargets(options.repositoryRoot, options.input);
  const states: Array<{ target: TargetFile; exists: boolean; same: boolean }> = [];
  const conflicts: string[] = [];

  for (const target of targets) {
    const destination = join(root, target.path);
    await assertSafeParents(root, destination);
    try {
      const metadata = await lstat(destination);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        conflicts.push(target.path);
        states.push({ target, exists: true, same: false });
        continue;
      }
      const same = (await readFile(destination, "utf8")) === target.content;
      if (!same) conflicts.push(target.path);
      states.push({ target, exists: true, same });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      states.push({ target, exists: false, same: false });
    }
  }

  const authorized = new Set(options.replaceExisting ?? []);
  const generatedPaths = new Set(states.map(({ target }) => target.path));
  for (const path of authorized) {
    // Authorizing a path this run does not generate is a mistake, not a licence.
    if (!generatedPaths.has(path)) throw new Error(`unknown replacement target: ${path}`);
  }
  const unauthorized = conflicts.filter((path) => !authorized.has(path));
  if (unauthorized.length > 0) throw new RenderConflictError(unauthorized.sort());

  if (!options.dryRun) {
    for (const state of states.filter(
      ({ exists, same, target }) => !exists || (!same && authorized.has(target.path)),
    )) {
      const destination = join(root, state.target.path);
      await mkdir(dirname(destination), { recursive: true });
      // Create-only unless this exact path was authorized for replacement.
      await writeFile(destination, state.target.content, {
        encoding: "utf8",
        flag: state.exists ? "w" : "wx",
        mode: state.target.mode,
      });
    }
  }

  return {
    schemaVersion: 1,
    profile: options.input.profile,
    platformRef: options.input.platformRef,
    files: states.map(({ target, exists, same }) => ({
      path: target.path,
      status: !exists
        ? (options.dryRun ? "planned" : "created")
        : same
          ? "unchanged"
          : (options.dryRun ? "planned" : "replaced"),
    })),
  };
}
