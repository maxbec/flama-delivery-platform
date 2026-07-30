import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyPaperclipControllers,
  type ControllerContract,
  type PaperclipAgent,
  type PaperclipControllersClient,
  PaperclipControllersError,
  type PaperclipControllersInput,
  PaperclipRestControllersClient,
  planPaperclipControllers,
} from "./paperclip-controllers.js";

const repositoryRoot = process.cwd();
const companyId = "10000000-0000-4000-8000-000000000001";

function input(): PaperclipControllersInput {
  return {
    schemaVersion: 1,
    company: { id: companyId, name: "Private" },
    controller: "maxbec-delivery-controller",
    runtimeRoot: repositoryRoot,
    mutationAllowed: true,
  };
}

async function contract(): Promise<ControllerContract> {
  return JSON.parse(await readFile(
    join(repositoryRoot, "lifecycles/controllers/maxbec-delivery-controller.json"),
    "utf8",
  )) as ControllerContract;
}

class MemoryControllersClient implements PaperclipControllersClient {
  agent: PaperclipAgent | undefined;
  createCalls = 0;
  pauseCalls = 0;
  updateCalls = 0;
  requireApproval = false;
  readonly skillKey = "flama-paperclip-delivery--managed";

  async getCompany(id: string) {
    return {
      id,
      name: "Private",
      status: "active",
      requireBoardApprovalForNewAgents: this.requireApproval,
    };
  }

  async listAgents(): Promise<readonly PaperclipAgent[]> {
    return this.agent === undefined ? [] : [this.agent];
  }

  async listSkills() {
    return [{ key: this.skillKey, name: "flama-paperclip-delivery" }];
  }

  async createAgent(
    id: string,
    value: Parameters<PaperclipControllersClient["createAgent"]>[1],
  ): Promise<PaperclipAgent> {
    this.createCalls += 1;
    this.agent = {
      id: "20000000-0000-4000-8000-000000000002",
      companyId: id,
      ...value,
      adapterConfig: {
        ...value.adapterConfig,
        paperclipSkillSync: { desiredSkills: value.desiredSkills },
      },
      status: "idle",
    };
    return this.agent;
  }

  async getAgent(): Promise<PaperclipAgent> {
    if (this.agent === undefined) throw new Error("missing");
    return this.agent;
  }

  async updateAgent(
    _agentId: string,
    patch: Parameters<PaperclipControllersClient["updateAgent"]>[1],
  ): Promise<PaperclipAgent> {
    if (this.agent === undefined) throw new Error("missing");
    this.updateCalls += 1;
    this.agent = { ...this.agent, ...patch };
    return this.agent;
  }

  async getAgentSkills() {
    return {
      adapterType: "process",
      supported: false,
      mode: "unsupported",
      desiredSkills: [this.skillKey],
    };
  }

  async pauseAgent(): Promise<PaperclipAgent> {
    if (this.agent === undefined) throw new Error("missing");
    this.pauseCalls += 1;
    this.agent = { ...this.agent, status: "paused" };
    return this.agent;
  }
}

describe("Paperclip delivery-controller provisioning", () => {
  it("plans a paused zero-budget controller without exposing private scope", async () => {
    const result = planPaperclipControllers(input(), await contract());

    expect(result).toMatchObject({
      status: "planned",
      controller: "maxbec-delivery-controller",
      disposition: "planned",
      initialStatus: "paused",
      budgetMonthlyCents: 0,
    });
    expect(JSON.stringify(result)).not.toContain(companyId);
    expect(JSON.stringify(result)).not.toContain(repositoryRoot);
  });

  it("creates, immediately pauses, verifies, and then reuses the exact controller", async () => {
    const client = new MemoryControllersClient();
    const controllerContract = await contract();

    const created = await applyPaperclipControllers(input(), controllerContract, client);
    const reused = await applyPaperclipControllers(input(), controllerContract, client);

    expect(created).toMatchObject({ status: "applied", disposition: "created" });
    expect(reused).toMatchObject({ status: "applied", disposition: "reused" });
    expect(client.createCalls).toBe(1);
    expect(client.pauseCalls).toBe(1);
    expect(client.agent).toMatchObject({
      status: "paused",
      budgetMonthlyCents: 0,
      permissions: { canCreateAgents: false, canCreateSkills: false, canAssignTasks: false },
    });
  });

  it("respects board approval policy before creating and refuses drift", async () => {
    const client = new MemoryControllersClient();
    client.requireApproval = true;
    await expect(applyPaperclipControllers(input(), await contract(), client)).rejects.toEqual(
      expect.objectContaining<Partial<PaperclipControllersError>>({ code: "paperclip_agent_approval_required" }),
    );
    expect(client.createCalls).toBe(0);

    client.requireApproval = false;
    await applyPaperclipControllers(input(), await contract(), client);
    if (client.agent !== undefined) client.agent = { ...client.agent, budgetMonthlyCents: 1 };
    await expect(applyPaperclipControllers(input(), await contract(), client)).rejects.toEqual(
      expect.objectContaining<Partial<PaperclipControllersError>>({ code: "paperclip_agent_drift" }),
    );
  });

  it("migrates only the exact paused source-checkout controller to the immutable bundle", async () => {
    const client = new MemoryControllersClient();
    const controllerContract = await contract();
    await applyPaperclipControllers(input(), controllerContract, client);
    if (client.agent === undefined) throw new Error("test setup failed");
    client.agent = {
      ...client.agent,
      adapterConfig: {
        ...client.agent.adapterConfig,
        args: ["dist/services/controller/src/main.js"],
      },
      metadata: {
        ...client.agent.metadata,
        topologyVersion: 1,
      },
    };

    await expect(applyPaperclipControllers(input(), controllerContract, client)).resolves.toMatchObject({
      disposition: "migrated",
    });
    expect(client.updateCalls).toBe(1);
    expect(client.agent).toMatchObject({
      adapterConfig: { args: ["bin/controller/index.js"] },
      metadata: { topologyVersion: 2 },
    });
  });

  it("migrates the declared legacy source checkout onto the immutable runtime root", async () => {
    const client = new MemoryControllersClient();
    const controllerContract = await contract();
    const legacySourceRoot = "/home/delivery/source-checkout";
    await applyPaperclipControllers({ ...input(), runtimeRoot: legacySourceRoot }, controllerContract, client);
    if (client.agent === undefined) throw new Error("test setup failed");
    client.agent = {
      ...client.agent,
      adapterConfig: {
        ...client.agent.adapterConfig,
        args: ["dist/services/controller/src/main.js"],
      },
      metadata: { ...client.agent.metadata, topologyVersion: 1 },
    };

    const migrated = await applyPaperclipControllers(
      { ...input(), runtimeRoot: "/home/delivery/release/v0.1.0", legacySourceRoot },
      controllerContract,
      client,
    );

    expect(migrated).toMatchObject({ disposition: "migrated" });
    expect(client.updateCalls).toBe(1);
    expect(client.agent).toMatchObject({
      adapterConfig: { args: ["bin/controller/index.js"], cwd: "/home/delivery/release/v0.1.0" },
      metadata: { topologyVersion: 2 },
    });
  });

  it("refuses a legacy working directory that was not declared", async () => {
    const client = new MemoryControllersClient();
    const controllerContract = await contract();
    await applyPaperclipControllers(
      { ...input(), runtimeRoot: "/home/delivery/unexpected-checkout" },
      controllerContract,
      client,
    );
    if (client.agent === undefined) throw new Error("test setup failed");
    client.agent = {
      ...client.agent,
      adapterConfig: {
        ...client.agent.adapterConfig,
        args: ["dist/services/controller/src/main.js"],
      },
      metadata: { ...client.agent.metadata, topologyVersion: 1 },
    };

    await expect(applyPaperclipControllers(
      {
        ...input(),
        runtimeRoot: "/home/delivery/release/v0.1.0",
        legacySourceRoot: "/home/delivery/source-checkout",
      },
      controllerContract,
      client,
    )).rejects.toEqual(
      expect.objectContaining<Partial<PaperclipControllersError>>({ code: "paperclip_agent_drift" }),
    );
    expect(client.updateCalls).toBe(0);
  });

  it("rejects a legacy source root that is absent, relative, denormalized, or the runtime root", async () => {
    const controllerContract = await contract();
    for (const legacySourceRoot of [
      repositoryRoot,
      "relative/source-checkout",
      "/home/delivery/../delivery/source-checkout",
      "",
    ]) {
      expect(() => planPaperclipControllers(
        { ...input(), legacySourceRoot },
        controllerContract,
      )).toThrow(expect.objectContaining<Partial<PaperclipControllersError>>({
        code: "paperclip_scope_invalid",
      }));
    }
  });

  it("migrates a controller whose contract was revised in place", async () => {
    const client = new MemoryControllersClient();
    const controllerContract = await contract();
    await applyPaperclipControllers(input(), controllerContract, client);
    if (client.agent === undefined) throw new Error("test setup failed");
    client.agent = {
      ...client.agent,
      metadata: { ...client.agent.metadata, contractDigest: `sha256:${"0".repeat(64)}` },
    };

    const migrated = await applyPaperclipControllers(input(), controllerContract, client);

    expect(migrated).toMatchObject({ disposition: "migrated" });
    expect(client.agent).toMatchObject({
      adapterConfig: { args: ["bin/controller/index.js"] },
      metadata: { topologyVersion: 2, contractDigest: migrated.contractDigest },
    });
  });

  it("refuses an agent that differs by more than its contract digest", async () => {
    const client = new MemoryControllersClient();
    const controllerContract = await contract();
    await applyPaperclipControllers(input(), controllerContract, client);
    if (client.agent === undefined) throw new Error("test setup failed");
    client.agent = {
      ...client.agent,
      budgetMonthlyCents: 500,
      metadata: { ...client.agent.metadata, contractDigest: `sha256:${"0".repeat(64)}` },
    };

    await expect(applyPaperclipControllers(input(), controllerContract, client)).rejects.toEqual(
      expect.objectContaining<Partial<PaperclipControllersError>>({ code: "paperclip_agent_drift" }),
    );
  });

  it("refuses an agent whose metadata drifted in any way other than the digest", async () => {
    const client = new MemoryControllersClient();
    const controllerContract = await contract();
    await applyPaperclipControllers(input(), controllerContract, client);
    if (client.agent === undefined) throw new Error("test setup failed");
    // Topology v1 without the legacy entrypoint is not a contract revision.
    client.agent = {
      ...client.agent,
      metadata: { ...client.agent.metadata, topologyVersion: 1 },
    };

    await expect(applyPaperclipControllers(input(), controllerContract, client)).rejects.toEqual(
      expect.objectContaining<Partial<PaperclipControllersError>>({ code: "paperclip_agent_drift" }),
    );
    expect(client.updateCalls).toBe(0);
  });

  it("refuses an agent carrying no contract digest at all", async () => {
    const client = new MemoryControllersClient();
    const controllerContract = await contract();
    await applyPaperclipControllers(input(), controllerContract, client);
    if (client.agent === undefined) throw new Error("test setup failed");
    const { contractDigest: _removed, ...withoutDigest } = client.agent.metadata as Record<string, unknown>;
    client.agent = { ...client.agent, metadata: withoutDigest };

    await expect(applyPaperclipControllers(input(), controllerContract, client)).rejects.toEqual(
      expect.objectContaining<Partial<PaperclipControllersError>>({ code: "paperclip_agent_drift" }),
    );
    expect(client.updateCalls).toBe(0);
  });

  it("suppresses credentials and rejected upstream bodies", async () => {
    const credential = `paperclip_${"sensitive".repeat(4)}`;
    const rejectedBody = `private upstream response ${credential}`;
    const client = new PaperclipRestControllersClient(
      { PAPERCLIP_API_URL: "http://127.0.0.1:3100", PAPERCLIP_API_KEY: credential },
      async () => new Response(rejectedBody, { status: 500 }),
    );
    let caught: unknown;
    try { await client.listAgents(companyId); } catch (error) { caught = error; }

    expect(caught).toEqual(expect.objectContaining<Partial<PaperclipControllersError>>({
      code: "paperclip_api_rejected",
    }));
    expect(String(caught)).not.toContain(credential);
    expect(JSON.stringify(caught)).not.toContain(credential);
    expect(String(caught)).not.toContain(rejectedBody);
  });
});
