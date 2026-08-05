import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyPaperclipFoundation,
  type LifecycleContract,
  PaperclipFoundationError,
  type PaperclipFoundationClient,
  type PaperclipFoundationInput,
  type PaperclipPipelineDetail,
  type PaperclipPipelineListItem,
  PaperclipRestFoundationClient,
  planPaperclipFoundation,
} from "./paperclip-foundation.js";

const repositoryRoot = process.cwd();

async function contracts(): Promise<readonly LifecycleContract[]> {
  return Promise.all(
    ["project-bootstrap", "feature-fix", "release-deployment"].map(async (name) =>
      JSON.parse(await readFile(join(repositoryRoot, "lifecycles", `${name}.json`), "utf8")) as LifecycleContract,
    ),
  );
}

function input(): PaperclipFoundationInput {
  return {
    schemaVersion: 1,
    company: { id: "10000000-0000-4000-8000-000000000001", name: "Private" },
    controller: "maxbec-delivery-controller",
    mutationAllowed: true,
  };
}

class MemoryPaperclipClient implements PaperclipFoundationClient {
  readonly details = new Map<string, PaperclipPipelineDetail>();
  createCalls = 0;
  replaceCalls = 0;
  failNextReplace = false;

  async getCompany(companyId: string) {
    return { id: companyId, name: "Private", status: "active" };
  }

  async listPipelines(_companyId: string): Promise<readonly PaperclipPipelineListItem[]> {
    return [...this.details.values()].map((pipeline) => ({
      id: pipeline.id,
      key: pipeline.key,
      name: pipeline.name,
      description: pipeline.description,
      enforceTransitions: pipeline.enforceTransitions,
      archivedAt: pipeline.archivedAt,
      openCaseCount: 0,
    }));
  }

  async createPipeline(
    _companyId: string,
    pipeline: Parameters<PaperclipFoundationClient["createPipeline"]>[1],
  ): Promise<{ readonly id: string }> {
    this.createCalls += 1;
    const id = `pipeline-${this.createCalls}`;
    this.details.set(id, {
      id,
      key: pipeline.key,
      name: pipeline.name,
      description: pipeline.description,
      enforceTransitions: false,
      archivedAt: null,
      stages: pipeline.stages.map((stage, index) => ({ ...stage, id: `${id}-stage-${index}` })),
      transitions: [],
    });
    return { id };
  }

  async getPipeline(pipelineId: string): Promise<PaperclipPipelineDetail> {
    const detail = this.details.get(pipelineId);
    if (detail === undefined) throw new Error("not found");
    return detail;
  }

  async replaceTransitions(
    pipelineId: string,
    value: Parameters<PaperclipFoundationClient["replaceTransitions"]>[1],
  ): Promise<void> {
    this.replaceCalls += 1;
    if (this.failNextReplace) {
      this.failNextReplace = false;
      throw new Error("transient");
    }
    const detail = await this.getPipeline(pipelineId);
    const idByKey = new Map(detail.stages.map((stage) => [stage.key, stage.id]));
    this.details.set(pipelineId, {
      ...detail,
      enforceTransitions: value.enforceTransitions,
      transitions: value.transitions.map((transition) => ({
        fromStageId: idByKey.get(transition.fromStageKey) ?? "missing",
        toStageId: idByKey.get(transition.toStageKey) ?? "missing",
        label: transition.label,
      })),
    });
  }
}

describe("Paperclip foundation installation", () => {
  it("plans all lifecycle pipelines without an API client or private identifiers in output", async () => {
    const result = planPaperclipFoundation(input(), await contracts());

    expect(result).toMatchObject({ status: "planned", summary: { planned: 3, created: 0, reused: 0 } });
    expect(result.pipelines.map(({ pipelineKey }) => pipelineKey)).toEqual([
      "flama-project-bootstrap-v1",
      "flama-feature-fix-v1",
      "flama-release-deployment-v1",
    ]);
    expect(JSON.stringify(result)).not.toContain(input().company.id);
  });

  it("creates exact enforced pipelines once and reuses them idempotently", async () => {
    const client = new MemoryPaperclipClient();
    const lifecycleContracts = await contracts();

    const created = await applyPaperclipFoundation(input(), lifecycleContracts, client);
    const reused = await applyPaperclipFoundation(input(), lifecycleContracts, client);

    expect(created).toMatchObject({ status: "applied", summary: { created: 3, reused: 0 } });
    expect(reused).toMatchObject({ status: "applied", summary: { created: 0, reused: 3 } });
    expect(client.createCalls).toBe(3);
    expect(client.replaceCalls).toBe(3);
    expect([...client.details.values()].every(({ enforceTransitions }) => enforceTransitions)).toBe(true);
    expect([...client.details.values()].every(({ stages }) =>
      stages.filter(({ kind }) => kind === "cancelled").length === 1 &&
      stages.some(({ kind }) => kind === "done")
    )).toBe(true);
    expect([...client.details.values()].every(({ stages, transitions }) => {
      const cancelledId = stages.find(({ kind }) => kind === "cancelled")?.id;
      return cancelledId !== undefined && transitions.every(({ fromStageId, toStageId }) =>
        fromStageId !== cancelledId && toStageId !== cancelledId
      );
    })).toBe(true);
  });

  it("recovers an exact Flama-owned pipeline whose transition publication was interrupted", async () => {
    const client = new MemoryPaperclipClient();
    client.failNextReplace = true;
    const lifecycleContracts = await contracts();

    await expect(applyPaperclipFoundation(input(), lifecycleContracts, client)).rejects.toThrow("transient");
    const recovered = await applyPaperclipFoundation(input(), lifecycleContracts, client);

    expect(recovered.summary).toEqual({ planned: 0, created: 2, reused: 1 });
    expect(client.createCalls).toBe(3);
  });

  it("fails closed on company/controller mismatch and managed-pipeline drift", async () => {
    const client = new MemoryPaperclipClient();
    const lifecycleContracts = await contracts();
    const wrongController = { ...input(), controller: "edilio-delivery-controller" as const };
    await expect(applyPaperclipFoundation(wrongController, lifecycleContracts, client)).rejects.toEqual(
      expect.objectContaining<Partial<PaperclipFoundationError>>({ code: "paperclip_scope_invalid" }),
    );

    await applyPaperclipFoundation(input(), lifecycleContracts, client);
    const first = [...client.details.values()][0];
    expect(first).toBeDefined();
    if (first !== undefined) client.details.set(first.id, { ...first, name: "User-edited pipeline" });

    await expect(applyPaperclipFoundation(input(), lifecycleContracts, client)).rejects.toEqual(
      expect.objectContaining<Partial<PaperclipFoundationError>>({ code: "paperclip_pipeline_drift" }),
    );
    expect(client.createCalls).toBe(3);
  });

  it("rejects duplicate lifecycle edges before making an API request", async () => {
    const lifecycleContracts = await contracts();
    const first = lifecycleContracts[0];
    const transition = first?.transitions[0];
    expect(first).toBeDefined();
    expect(transition).toBeDefined();
    if (first === undefined || transition === undefined) return;
    const malformed = [
      { ...first, transitions: [...first.transitions, transition] },
      ...lifecycleContracts.slice(1),
    ];

    expect(() => planPaperclipFoundation(input(), malformed)).toThrow(
      expect.objectContaining<Partial<PaperclipFoundationError>>({ code: "paperclip_contract_invalid" }),
    );
  });

  it("suppresses credentials and rejected API response bodies", async () => {
    const credential = `paperclip_${"sensitive".repeat(4)}`;
    const rejectedBody = `upstream diagnostic includes ${credential}`;
    const client = new PaperclipRestFoundationClient(
      { PAPERCLIP_API_URL: "http://127.0.0.1:3100", PAPERCLIP_API_KEY: credential },
      async () => new Response(rejectedBody, { status: 500 }),
    );

    let caught: unknown;
    try {
      await client.listPipelines(input().company.id);
    } catch (error) {
      caught = error;
    }

    expect(caught).toEqual(
      expect.objectContaining<Partial<PaperclipFoundationError>>({ code: "paperclip_api_rejected" }),
    );
    expect(String(caught)).not.toContain(credential);
    expect(JSON.stringify(caught)).not.toContain(credential);
    expect(String(caught)).not.toContain(rejectedBody);
  });

  it("accepts HTTPS or loopback HTTP endpoints only", () => {
    const credential = `paperclip_${"credential".repeat(4)}`;
    expect(() => new PaperclipRestFoundationClient({
      PAPERCLIP_API_URL: "http://paperclip.example.test",
      PAPERCLIP_API_KEY: credential,
    })).toThrow(expect.objectContaining<Partial<PaperclipFoundationError>>({
      code: "paperclip_identity_unavailable",
    }));
    expect(() => new PaperclipRestFoundationClient({
      PAPERCLIP_API_URL: "https://paperclip.example.test",
      PAPERCLIP_API_KEY: credential,
    })).not.toThrow();
  });
});
