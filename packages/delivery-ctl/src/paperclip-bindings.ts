import { createHash } from "node:crypto";
import { Pool } from "pg";

const companyControllers = {
  Private: { owner: "maxbec", controller: "maxbec-delivery-controller" },
  "// Navigaite": { owner: "navigaite", controller: "navigaite-delivery-controller" },
  Edilio: { owner: "edilio-app", controller: "edilio-delivery-controller" },
} as const;

type CompanyName = keyof typeof companyControllers;
type Owner = typeof companyControllers[CompanyName]["owner"];
type ControllerName = typeof companyControllers[CompanyName]["controller"];
type Profile = "fast" | "major";
type Disposition = "planned" | "created" | "refreshed" | "reused";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const branchPattern = /^(?!\/|.*(?:\.\.|\/\/|@\{|[\u0000-\u0020\u007f~^:?*\[\\]))(?!.*(?:\.|\/|\.lock)$).{1,255}$/u;
const maximumInventoryAgeMilliseconds = 24 * 60 * 60 * 1_000;

export interface PaperclipBindingInput {
  readonly schemaVersion: 1;
  readonly company: { readonly id: string; readonly name: CompanyName };
  readonly controller: ControllerName;
  readonly repository: {
    readonly nameWithOwner: string;
    readonly githubRepositoryId: number;
    readonly profile: Profile;
    readonly defaultBranch: string;
    readonly isFork: false;
    readonly isArchived: false;
    readonly inventoryDigest: string;
    readonly inventoryVerifiedAt: string;
  };
  readonly project: { readonly id: string };
  readonly workspace: { readonly id: string };
  readonly mutationAllowed: true;
}

export interface PaperclipProject {
  readonly id: string;
  readonly companyId: string;
  readonly status: string;
  readonly archivedAt?: string | null;
}

export interface PaperclipProjectWorkspace {
  readonly id: string;
  readonly companyId: string;
  readonly projectId: string;
  readonly sourceType: string;
  readonly repoUrl?: string | null;
  readonly defaultRef?: string | null;
}

export interface PaperclipBindingsClient {
  getCompany(companyId: string): Promise<{ readonly id: string; readonly name: string; readonly status?: string }>;
  getProject(projectId: string): Promise<PaperclipProject>;
  listProjectWorkspaces(projectId: string): Promise<readonly PaperclipProjectWorkspace[]>;
}

export interface RepositoryBindingRecord {
  readonly repositoryName: string;
  readonly githubRepositoryId: number;
  readonly ownerName: Owner;
  readonly company: CompanyName;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly profile: Profile;
  readonly defaultBranch: string;
  readonly active: true;
  readonly isFork: false;
  readonly isArchived: false;
  readonly inventoryDigest: string;
  readonly verifiedAt: string;
  readonly bindingDigest: string;
}

export interface RepositoryBindingStore {
  get(repositoryName: string): Promise<RepositoryBindingRecord | undefined>;
  insert(binding: RepositoryBindingRecord): Promise<void>;
  refresh(binding: RepositoryBindingRecord): Promise<void>;
}

export interface PaperclipBindingResult {
  readonly schemaVersion: 1;
  readonly status: "planned" | "applied";
  readonly disposition: Disposition;
  readonly bindingDigest: string;
}

export type PaperclipBindingsErrorCode =
  | "paperclip_api_rejected"
  | "paperclip_binding_drift"
  | "paperclip_binding_persistence_failed"
  | "paperclip_company_mismatch"
  | "paperclip_identity_unavailable"
  | "paperclip_inventory_stale"
  | "paperclip_project_mismatch"
  | "paperclip_response_invalid"
  | "paperclip_scope_invalid"
  | "paperclip_workspace_mismatch";

export class PaperclipBindingsError extends Error {
  constructor(readonly code: PaperclipBindingsErrorCode) {
    super("Paperclip repository binding rejected");
    this.name = "PaperclipBindingsError";
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(
      ([key, nested]) => [key, stableValue(nested)],
    ));
  }
  return value;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex")}`;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function validateScope(input: PaperclipBindingInput): { readonly owner: Owner; readonly verifiedAt: Date } {
  const company = companyControllers[input.company.name];
  const verifiedAt = new Date(input.repository.inventoryVerifiedAt);
  if (
    input.schemaVersion !== 1 || input.mutationAllowed !== true || company === undefined ||
    company.controller !== input.controller || !uuidPattern.test(input.company.id) ||
    !uuidPattern.test(input.project.id) || !uuidPattern.test(input.workspace.id) ||
    input.repository.nameWithOwner.split("/")[0] !== company.owner ||
    !new RegExp(`^${company.owner}/[A-Za-z0-9._-]+$`, "u").test(input.repository.nameWithOwner) ||
    !Number.isSafeInteger(input.repository.githubRepositoryId) || input.repository.githubRepositoryId <= 0 ||
    !["fast", "major"].includes(input.repository.profile) ||
    !branchPattern.test(input.repository.defaultBranch) || input.repository.isFork !== false ||
    input.repository.isArchived !== false || !digestPattern.test(input.repository.inventoryDigest) ||
    !Number.isFinite(verifiedAt.getTime()) || verifiedAt.toISOString() !== input.repository.inventoryVerifiedAt
  ) throw new PaperclipBindingsError("paperclip_scope_invalid");
  return { owner: company.owner, verifiedAt };
}

function repositoryUrlMatches(value: string | null | undefined, repository: string): boolean {
  if (value === null || value === undefined) return false;
  try {
    const url = new URL(value);
    const expectedPath = `/${repository}`;
    const path = url.pathname.endsWith(".git") ? url.pathname.slice(0, -4) : url.pathname.replace(/\/$/u, "");
    return url.protocol === "https:" && url.hostname.toLowerCase() === "github.com" &&
      url.username === "" && url.password === "" && url.search === "" && url.hash === "" && path === expectedPath;
  } catch {
    return false;
  }
}

function binding(input: PaperclipBindingInput, owner: Owner, verifiedAt: Date): RepositoryBindingRecord {
  const unsigned = {
    repositoryName: input.repository.nameWithOwner,
    githubRepositoryId: input.repository.githubRepositoryId,
    ownerName: owner,
    company: input.company.name,
    projectId: input.project.id,
    workspaceId: input.workspace.id,
    profile: input.repository.profile,
    defaultBranch: input.repository.defaultBranch,
    active: true as const,
    isFork: false as const,
    isArchived: false as const,
    inventoryDigest: input.repository.inventoryDigest,
    verifiedAt: verifiedAt.toISOString(),
  };
  return { ...unsigned, bindingDigest: digest(unsigned) };
}

function result(
  status: "planned" | "applied",
  disposition: Disposition,
  value: RepositoryBindingRecord,
): PaperclipBindingResult {
  return { schemaVersion: 1, status, disposition, bindingDigest: value.bindingDigest };
}

function mappingMatches(left: RepositoryBindingRecord, right: RepositoryBindingRecord): boolean {
  return left.repositoryName === right.repositoryName && left.githubRepositoryId === right.githubRepositoryId &&
    left.ownerName === right.ownerName && left.company === right.company && left.projectId === right.projectId &&
    left.workspaceId === right.workspaceId && left.profile === right.profile &&
    left.defaultBranch === right.defaultBranch && left.active === true && left.isFork === false &&
    left.isArchived === false;
}

export function planPaperclipBinding(input: PaperclipBindingInput): PaperclipBindingResult {
  const { owner, verifiedAt } = validateScope(input);
  return result("planned", "planned", binding(input, owner, verifiedAt));
}

export async function applyPaperclipBinding(
  input: PaperclipBindingInput,
  client: PaperclipBindingsClient,
  store: RepositoryBindingStore,
  now = new Date(),
): Promise<PaperclipBindingResult> {
  const { owner, verifiedAt } = validateScope(input);
  if (
    verifiedAt.getTime() > now.getTime() + 60_000 ||
    now.getTime() - verifiedAt.getTime() > maximumInventoryAgeMilliseconds
  ) throw new PaperclipBindingsError("paperclip_inventory_stale");

  const company = await client.getCompany(input.company.id);
  if (company.id !== input.company.id || company.name !== input.company.name || company.status !== "active") {
    throw new PaperclipBindingsError("paperclip_company_mismatch");
  }
  const project = await client.getProject(input.project.id);
  if (
    project.id !== input.project.id || project.companyId !== input.company.id || project.archivedAt != null ||
    !["backlog", "planned", "in_progress"].includes(project.status)
  ) throw new PaperclipBindingsError("paperclip_project_mismatch");

  const matches = (await client.listProjectWorkspaces(input.project.id)).filter(({ id }) => id === input.workspace.id);
  const workspace = matches[0];
  if (
    matches.length !== 1 || workspace === undefined || workspace.companyId !== input.company.id ||
    workspace.projectId !== input.project.id ||
    !["local_path", "git_repo", "remote_managed"].includes(workspace.sourceType) ||
    !repositoryUrlMatches(workspace.repoUrl, input.repository.nameWithOwner) ||
    workspace.defaultRef !== input.repository.defaultBranch
  ) throw new PaperclipBindingsError("paperclip_workspace_mismatch");

  const expected = binding(input, owner, verifiedAt);
  const existing = await store.get(expected.repositoryName);
  if (existing === undefined) {
    await store.insert(expected);
    const observed = await store.get(expected.repositoryName);
    if (observed === undefined || !sameJson(observed, expected)) {
      throw new PaperclipBindingsError("paperclip_binding_persistence_failed");
    }
    return result("applied", "created", expected);
  }
  if (!mappingMatches(existing, expected)) throw new PaperclipBindingsError("paperclip_binding_drift");
  if (sameJson(existing, expected)) return result("applied", "reused", expected);
  await store.refresh(expected);
  const observed = await store.get(expected.repositoryName);
  if (observed === undefined || !sameJson(observed, expected)) {
    throw new PaperclipBindingsError("paperclip_binding_persistence_failed");
  }
  return result("applied", "refreshed", expected);
}

type Environment = Readonly<Record<string, string | undefined>>;
type FetchImplementation = (input: string | URL, init?: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class PaperclipRestBindingsClient implements PaperclipBindingsClient {
  readonly #apiBase: string;
  readonly #token: string;

  constructor(environment: Environment, private readonly fetchImplementation: FetchImplementation = fetch) {
    const apiBase = environment["PAPERCLIP_API_URL"];
    const token = environment["PAPERCLIP_API_KEY"];
    if (apiBase === undefined || token === undefined || token.length < 20 || token.length > 4_096 || /[\r\n]/u.test(token)) {
      throw new PaperclipBindingsError("paperclip_identity_unavailable");
    }
    let url: URL;
    try { url = new URL(apiBase); } catch { throw new PaperclipBindingsError("paperclip_identity_unavailable"); }
    const localHttp = url.protocol === "http:" && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !localHttp) || url.username || url.password || url.search || url.hash) {
      throw new PaperclipBindingsError("paperclip_identity_unavailable");
    }
    this.#apiBase = url.toString().replace(/\/+$/u, "");
    this.#token = token;
  }

  async #request(path: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.#apiBase}${path}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.#token}`, Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch { throw new PaperclipBindingsError("paperclip_api_rejected"); }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new PaperclipBindingsError("paperclip_api_rejected");
    }
    const length = response.headers.get("content-length");
    if (length !== null && (!/^[0-9]+$/u.test(length) || Number(length) > 2_097_152)) {
      await response.body?.cancel();
      throw new PaperclipBindingsError("paperclip_response_invalid");
    }
    let source: string;
    try { source = await response.text(); } catch { throw new PaperclipBindingsError("paperclip_response_invalid"); }
    if (Buffer.byteLength(source, "utf8") > 2_097_152) throw new PaperclipBindingsError("paperclip_response_invalid");
    try { return JSON.parse(source) as unknown; } catch { throw new PaperclipBindingsError("paperclip_response_invalid"); }
  }

  async getCompany(companyId: string): ReturnType<PaperclipBindingsClient["getCompany"]> {
    const value = await this.#request(`/api/companies/${encodeURIComponent(companyId)}`);
    if (!isRecord(value) || typeof value["id"] !== "string" || typeof value["name"] !== "string") {
      throw new PaperclipBindingsError("paperclip_response_invalid");
    }
    return value as unknown as Awaited<ReturnType<PaperclipBindingsClient["getCompany"]>>;
  }

  async getProject(projectId: string): Promise<PaperclipProject> {
    const value = await this.#request(`/api/projects/${encodeURIComponent(projectId)}`);
    if (!isRecord(value) || typeof value["id"] !== "string" || typeof value["companyId"] !== "string" ||
      typeof value["status"] !== "string" ||
      (value["archivedAt"] !== undefined && value["archivedAt"] !== null && typeof value["archivedAt"] !== "string")) {
      throw new PaperclipBindingsError("paperclip_response_invalid");
    }
    return value as unknown as PaperclipProject;
  }

  async listProjectWorkspaces(projectId: string): Promise<readonly PaperclipProjectWorkspace[]> {
    const value = await this.#request(`/api/projects/${encodeURIComponent(projectId)}/workspaces`);
    if (!Array.isArray(value) || value.some((workspace) =>
      !isRecord(workspace) || typeof workspace["id"] !== "string" ||
      typeof workspace["companyId"] !== "string" || typeof workspace["projectId"] !== "string" ||
      typeof workspace["sourceType"] !== "string" ||
      (workspace["repoUrl"] !== undefined && workspace["repoUrl"] !== null && typeof workspace["repoUrl"] !== "string") ||
      (workspace["defaultRef"] !== undefined && workspace["defaultRef"] !== null && typeof workspace["defaultRef"] !== "string")
    )) throw new PaperclipBindingsError("paperclip_response_invalid");
    return value as unknown as readonly PaperclipProjectWorkspace[];
  }
}

interface BindingRow {
  readonly repository_name: string;
  readonly github_repository_id: string;
  readonly owner_name: Owner;
  readonly company: CompanyName;
  readonly project_id: string;
  readonly workspace_id: string;
  readonly profile: Profile;
  readonly default_branch: string;
  readonly active: boolean;
  readonly is_fork: boolean;
  readonly is_archived: boolean;
  readonly inventory_digest: string;
  readonly verified_at: Date;
  readonly binding_digest: string;
}

function rowBinding(row: BindingRow): RepositoryBindingRecord {
  const repositoryId = Number(row.github_repository_id);
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
    throw new PaperclipBindingsError("paperclip_binding_persistence_failed");
  }
  return {
    repositoryName: row.repository_name,
    githubRepositoryId: repositoryId,
    ownerName: row.owner_name,
    company: row.company,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    profile: row.profile,
    defaultBranch: row.default_branch,
    active: row.active as true,
    isFork: row.is_fork as false,
    isArchived: row.is_archived as false,
    inventoryDigest: row.inventory_digest,
    verifiedAt: row.verified_at.toISOString(),
    bindingDigest: row.binding_digest,
  };
}

export class PostgresRepositoryBindingStore implements RepositoryBindingStore {
  readonly #pool: Pool;

  constructor(environment: Environment) {
    const source = environment["DATABASE_URL"];
    if (source === undefined || source.length > 4_096 || /[\r\n]/u.test(source)) {
      throw new PaperclipBindingsError("paperclip_identity_unavailable");
    }
    try {
      const url = new URL(source);
      if (!(["postgres:", "postgresql:"] as const).includes(url.protocol as "postgres:" | "postgresql:") || !url.hostname) {
        throw new Error("invalid");
      }
    } catch { throw new PaperclipBindingsError("paperclip_identity_unavailable"); }
    this.#pool = new Pool({ connectionString: source, max: 1, application_name: "flama-delivery-bindings" });
  }

  async close(): Promise<void> { await this.#pool.end(); }

  async get(repositoryName: string): Promise<RepositoryBindingRecord | undefined> {
    let rows: readonly BindingRow[];
    try {
      const result = await this.#pool.query<BindingRow>(
        `SELECT repository_name, github_repository_id::text, owner_name, company, project_id,
                workspace_id, profile, default_branch, active, is_fork, is_archived,
                inventory_digest, verified_at, binding_digest
         FROM flama_delivery.repository_binding WHERE repository_name = $1`,
        [repositoryName],
      );
      rows = result.rows;
    } catch { throw new PaperclipBindingsError("paperclip_binding_persistence_failed"); }
    if (rows.length > 1) throw new PaperclipBindingsError("paperclip_binding_persistence_failed");
    return rows[0] === undefined ? undefined : rowBinding(rows[0]);
  }

  async insert(value: RepositoryBindingRecord): Promise<void> {
    try {
      await this.#pool.query(
        `INSERT INTO flama_delivery.repository_binding
          (repository_name, github_repository_id, owner_name, company, project_id, workspace_id,
           profile, default_branch, active, is_fork, is_archived, inventory_digest, verified_at, binding_digest)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, false, false, $9, $10, $11)`,
        [value.repositoryName, value.githubRepositoryId, value.ownerName, value.company, value.projectId,
          value.workspaceId, value.profile, value.defaultBranch, value.inventoryDigest, value.verifiedAt,
          value.bindingDigest],
      );
    } catch { throw new PaperclipBindingsError("paperclip_binding_persistence_failed"); }
  }

  async refresh(value: RepositoryBindingRecord): Promise<void> {
    try {
      const result = await this.#pool.query(
        `UPDATE flama_delivery.repository_binding
         SET inventory_digest = $2, verified_at = $3, binding_digest = $4, updated_at = CURRENT_TIMESTAMP
         WHERE repository_name = $1 AND github_repository_id = $5 AND owner_name = $6 AND company = $7
           AND project_id = $8 AND workspace_id = $9 AND profile = $10 AND default_branch = $11
           AND active AND NOT is_fork AND NOT is_archived`,
        [value.repositoryName, value.inventoryDigest, value.verifiedAt, value.bindingDigest,
          value.githubRepositoryId, value.ownerName, value.company, value.projectId, value.workspaceId,
          value.profile, value.defaultBranch],
      );
      if (result.rowCount !== 1) throw new Error("drift");
    } catch { throw new PaperclipBindingsError("paperclip_binding_persistence_failed"); }
  }
}
