import { describe, expect, it } from "vitest";
import {
  applyPaperclipBinding,
  type PaperclipBindingInput,
  type PaperclipBindingsClient,
  PaperclipBindingsError,
  PaperclipRestBindingsClient,
  planPaperclipBinding,
  type RepositoryBindingRecord,
  type RepositoryBindingStore,
} from "./paperclip-bindings.js";

const companyId = "10000000-0000-4000-8000-000000000001";
const projectId = "20000000-0000-4000-8000-000000000002";
const workspaceId = "30000000-0000-4000-8000-000000000003";
const verifiedAt = "2026-07-29T04:00:00.000Z";

function input(): PaperclipBindingInput {
  return {
    schemaVersion: 1,
    company: { id: companyId, name: "Private" },
    controller: "maxbec-delivery-controller",
    repository: {
      nameWithOwner: "maxbec/example",
      githubRepositoryId: 101,
      profile: "fast",
      defaultBranch: "main",
      isFork: false,
      isArchived: false,
      inventoryDigest: `sha256:${"d".repeat(64)}`,
      inventoryVerifiedAt: verifiedAt,
    },
    project: { id: projectId },
    workspace: { id: workspaceId },
    mutationAllowed: true,
  };
}

class MemoryClient implements PaperclipBindingsClient {
  workspaceRepository = "https://github.com/maxbec/example.git";

  async getCompany() { return { id: companyId, name: "Private", status: "active" }; }
  async getProject() { return { id: projectId, companyId, status: "in_progress", archivedAt: null }; }
  async listProjectWorkspaces() {
    return [{
      id: workspaceId,
      companyId,
      projectId,
      sourceType: "git_repo",
      repoUrl: this.workspaceRepository,
      defaultRef: "main",
    }];
  }
}

class MemoryStore implements RepositoryBindingStore {
  value: RepositoryBindingRecord | undefined;
  inserts = 0;
  refreshes = 0;

  async get() { return this.value; }
  async insert(value: RepositoryBindingRecord) { this.inserts += 1; this.value = value; }
  async refresh(value: RepositoryBindingRecord) { this.refreshes += 1; this.value = value; }
}

describe("Paperclip project/workspace bindings", () => {
  it("plans without identity and omits repository and Paperclip identifiers", () => {
    const planned = planPaperclipBinding(input());

    expect(planned).toMatchObject({ status: "planned", disposition: "planned" });
    expect(planned.bindingDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(JSON.stringify(planned)).not.toContain("maxbec/example");
    expect(JSON.stringify(planned)).not.toContain(companyId);
    expect(JSON.stringify(planned)).not.toContain(projectId);
    expect(JSON.stringify(planned)).not.toContain(workspaceId);
  });

  it("creates, reuses, and refreshes only an exact verified mapping", async () => {
    const client = new MemoryClient();
    const store = new MemoryStore();
    const now = new Date("2026-07-29T04:30:00.000Z");

    const created = await applyPaperclipBinding(input(), client, store, now);
    const reused = await applyPaperclipBinding(input(), client, store, now);
    const refreshedInput = {
      ...input(),
      repository: {
        ...input().repository,
        inventoryDigest: `sha256:${"e".repeat(64)}`,
        inventoryVerifiedAt: "2026-07-29T04:10:00.000Z",
      },
    } as const;
    const refreshed = await applyPaperclipBinding(refreshedInput, client, store, now);

    expect(created.disposition).toBe("created");
    expect(reused.disposition).toBe("reused");
    expect(refreshed.disposition).toBe("refreshed");
    expect(store.inserts).toBe(1);
    expect(store.refreshes).toBe(1);
  });

  it("rejects stale inventory, wrong workspace remotes, and stored mapping drift", async () => {
    const client = new MemoryClient();
    const store = new MemoryStore();
    await expect(applyPaperclipBinding(
      input(), client, store, new Date("2026-07-31T04:00:00.000Z"),
    )).rejects.toEqual(expect.objectContaining<Partial<PaperclipBindingsError>>({
      code: "paperclip_inventory_stale",
    }));

    client.workspaceRepository = "https://github.com/maxbec/different.git";
    await expect(applyPaperclipBinding(
      input(), client, store, new Date("2026-07-29T04:30:00.000Z"),
    )).rejects.toEqual(expect.objectContaining<Partial<PaperclipBindingsError>>({
      code: "paperclip_workspace_mismatch",
    }));

    client.workspaceRepository = "https://github.com/maxbec/example.git";
    await applyPaperclipBinding(input(), client, store, new Date("2026-07-29T04:30:00.000Z"));
    if (store.value !== undefined) store.value = { ...store.value, workspaceId: companyId };
    await expect(applyPaperclipBinding(
      input(), client, store, new Date("2026-07-29T04:30:00.000Z"),
    )).rejects.toEqual(expect.objectContaining<Partial<PaperclipBindingsError>>({
      code: "paperclip_binding_drift",
    }));
  });

  it("suppresses credentials and upstream rejection bodies", async () => {
    const credential = `paperclip_${"sensitive".repeat(4)}`;
    const rejectedBody = `private upstream response ${credential}`;
    const client = new PaperclipRestBindingsClient(
      { PAPERCLIP_API_URL: "http://127.0.0.1:3100", PAPERCLIP_API_KEY: credential },
      async () => new Response(rejectedBody, { status: 500 }),
    );
    let caught: unknown;
    try { await client.getProject(projectId); } catch (error) { caught = error; }

    expect(caught).toEqual(expect.objectContaining<Partial<PaperclipBindingsError>>({
      code: "paperclip_api_rejected",
    }));
    expect(String(caught)).not.toContain(credential);
    expect(JSON.stringify(caught)).not.toContain(credential);
    expect(String(caught)).not.toContain(rejectedBody);
  });
});
