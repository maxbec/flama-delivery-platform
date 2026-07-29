import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  applyPaperclipRoutines,
  PaperclipRestRoutinesClient,
  PaperclipRoutinesError,
  planPaperclipRoutines,
  type PaperclipRoutineContract,
  type PaperclipRoutineDetail,
  type PaperclipRoutinesClient,
  type PaperclipRoutinesInput,
} from "./paperclip-routines.js";

const input: PaperclipRoutinesInput = {
  schemaVersion: 1,
  company: { id: "11111111-1111-4111-8111-111111111111", name: "Private" },
  controller: "maxbec-delivery-controller",
  controllerAgentId: "22222222-2222-4222-8222-222222222222",
  projectId: "33333333-3333-4333-8333-333333333333",
  mutationAllowed: true,
};

const contract = JSON.parse(
  await readFile(new URL("../../../routines/nightly-reconciliation.json", import.meta.url), "utf8"),
) as PaperclipRoutineContract;

class FakeClient implements PaperclipRoutinesClient {
  routine: PaperclipRoutineDetail | undefined;
  createdRoutines = 0;
  createdTriggers = 0;
  agentStatus = "paused";

  constructor(existing = false) {
    if (existing) this.routine = this.baseRoutine([]);
  }

  private description(): string {
    return planPaperclipRoutines(input, contract).contractDigest;
  }

  private baseRoutine(triggers: PaperclipRoutineDetail["triggers"]): PaperclipRoutineDetail {
    return {
      id: "44444444-4444-4444-8444-444444444444",
      companyId: input.company.id,
      projectId: input.projectId,
      folderId: null,
      goalId: null,
      parentIssueId: null,
      title: contract.title,
      description: `Managed by flama-delivery-platform; key=${contract.key}; contract=${this.description()}\n\n${contract.description}`,
      assigneeAgentId: input.controllerAgentId,
      priority: "low",
      status: "paused",
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed",
      variables: [],
      triggers,
    };
  }

  async getCompany() {
    return { id: input.company.id, name: input.company.name, status: "active" };
  }

  async getAgent() {
    return {
      id: input.controllerAgentId,
      companyId: input.company.id,
      name: input.controller,
      role: "devops",
      adapterType: "process",
      budgetMonthlyCents: 0,
      status: this.agentStatus,
    };
  }

  async getProject() {
    return { id: input.projectId, companyId: input.company.id, status: "in_progress", archivedAt: null };
  }

  async listRoutines() {
    return this.routine === undefined ? [] : [{ id: this.routine.id, title: this.routine.title }];
  }

  async createRoutine() {
    this.createdRoutines += 1;
    this.routine = this.baseRoutine([]);
    return { id: this.routine.id };
  }

  async getRoutine() {
    if (this.routine === undefined) throw new Error("routine missing");
    return this.routine;
  }

  async createScheduleTrigger() {
    this.createdTriggers += 1;
    this.routine = this.baseRoutine([{
      id: "55555555-5555-4555-8555-555555555555",
      kind: "schedule",
      label: contract.trigger.label,
      enabled: true,
      cronExpression: contract.trigger.cronByCompany.Private,
      timezone: contract.trigger.timezone,
    }]);
  }
}

describe("Paperclip routine provisioning", () => {
  it("plans a paused, staggered nightly reconciliation without identity", () => {
    const result = planPaperclipRoutines(input, contract);
    expect(result).toMatchObject({
      status: "planned",
      disposition: "planned",
      initialStatus: "paused",
      trigger: { kind: "schedule", enabled: true, cronExpression: "17 1 * * *", timezone: "Europe/Berlin" },
    });
  });

  it("creates the paused routine and trigger then reuses them idempotently", async () => {
    const client = new FakeClient();
    await expect(applyPaperclipRoutines(input, contract, client)).resolves.toMatchObject({
      status: "applied",
      disposition: "created",
      initialStatus: "paused",
    });
    expect(client.createdRoutines).toBe(1);
    expect(client.createdTriggers).toBe(1);
    await expect(applyPaperclipRoutines(input, contract, client)).resolves.toMatchObject({ disposition: "reused" });
    expect(client.createdRoutines).toBe(1);
    expect(client.createdTriggers).toBe(1);
  });

  it("resumes an exact interrupted creation with no trigger", async () => {
    const client = new FakeClient(true);
    await expect(applyPaperclipRoutines(input, contract, client)).resolves.toMatchObject({ disposition: "reused" });
    expect(client.createdRoutines).toBe(0);
    expect(client.createdTriggers).toBe(1);
  });

  it("refuses pending approval and routine drift", async () => {
    const pending = new FakeClient();
    pending.agentStatus = "pending_approval";
    await expect(applyPaperclipRoutines(input, contract, pending)).rejects.toMatchObject({
      code: "paperclip_agent_approval_required",
    });

    const drifted = new FakeClient(true);
    if (drifted.routine === undefined) throw new Error("test setup failed");
    drifted.routine = { ...drifted.routine, status: "active" };
    await expect(applyPaperclipRoutines(input, contract, drifted)).rejects.toMatchObject({ code: "paperclip_routine_drift" });
  });

  it("uses documented endpoints and suppresses rejected response bodies", async () => {
    const credential = "test-only-paperclip-routines-key";
    const requests: Array<{ url: string; method: string | undefined; authorization: string | null }> = [];
    const client = new PaperclipRestRoutinesClient(
      { PAPERCLIP_API_URL: "http://127.0.0.1:3100", PAPERCLIP_API_KEY: credential },
      async (request, init) => {
        requests.push({
          url: String(request),
          method: init?.method,
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return new Response("do-not-reflect-this-body", { status: 403 });
      },
    );
    let observed: unknown;
    try {
      await client.getCompany(input.company.id);
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(PaperclipRoutinesError);
    expect(String(observed)).not.toContain("do-not-reflect-this-body");
    expect(requests[0]).toEqual({
      url: `http://127.0.0.1:3100/api/companies/${input.company.id}`,
      method: "GET",
      authorization: `Bearer ${credential}`,
    });
  });
});
