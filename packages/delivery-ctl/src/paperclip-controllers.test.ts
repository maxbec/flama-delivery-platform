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
