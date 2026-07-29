import { describe, expect, it } from "vitest";
import { ControllerRuntimeError, runControllerRuntime } from "./controller-runtime.js";

const agentId = "10000000-0000-4000-8000-000000000001";
const companyId = "20000000-0000-4000-8000-000000000002";
const runId = "30000000-0000-4000-8000-000000000003";
const token = `paperclip_${"controller".repeat(4)}`;

const environment = {
  PAPERCLIP_API_URL: "http://127.0.0.1:3100",
  PAPERCLIP_API_KEY: token,
  PAPERCLIP_AGENT_ID: agentId,
  PAPERCLIP_COMPANY_ID: companyId,
  PAPERCLIP_RUN_ID: runId,
};

function identity() {
  return {
    id: agentId,
    companyId,
    name: "maxbec-delivery-controller",
    role: "devops",
    adapterType: "process",
    budgetMonthlyCents: 0,
  };
}

function fetchFor(assignments: readonly unknown[]): typeof fetch {
  return async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname === "/api/agents/me") {
      return new Response(JSON.stringify(identity()), { status: 200 });
    }
    if (url.pathname.endsWith("/issues")) {
      expect(url.searchParams.get("assigneeAgentId")).toBe(agentId);
      return new Response(JSON.stringify(assignments), { status: 200 });
    }
    return new Response(null, { status: 404 });
  };
}

describe("deterministic delivery controller runtime", () => {
  it("authenticates its exact zero-budget process identity and idles without assignments", async () => {
    const result = await runControllerRuntime(environment, process.cwd(), fetchFor([]));

    expect(result).toMatchObject({ schemaVersion: 1, status: "idle" });
    expect(result.contractDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(JSON.stringify(result)).not.toContain(agentId);
    expect(JSON.stringify(result)).not.toContain(companyId);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("fails closed before interpreting an unsupported assignment", async () => {
    await expect(
      runControllerRuntime(environment, process.cwd(), fetchFor([{ id: "private-task" }])),
    ).rejects.toEqual(expect.objectContaining<Partial<ControllerRuntimeError>>({
      code: "controller_assignment_unsupported",
    }));
  });

  it("rejects identity drift and suppresses upstream bodies and credentials", async () => {
    const mismatchedFetch: typeof fetch = async () => new Response(JSON.stringify({
      ...identity(),
      budgetMonthlyCents: 1,
    }), { status: 200 });
    await expect(
      runControllerRuntime(environment, process.cwd(), mismatchedFetch),
    ).rejects.toEqual(expect.objectContaining<Partial<ControllerRuntimeError>>({
      code: "controller_identity_invalid",
    }));

    const rejectedBody = `private upstream error ${token}`;
    let caught: unknown;
    try {
      await runControllerRuntime(
        environment,
        process.cwd(),
        async () => new Response(rejectedBody, { status: 500 }),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toEqual(expect.objectContaining<Partial<ControllerRuntimeError>>({
      code: "controller_api_rejected",
    }));
    expect(String(caught)).not.toContain(token);
    expect(JSON.stringify(caught)).not.toContain(token);
    expect(String(caught)).not.toContain(rejectedBody);
  });
});
