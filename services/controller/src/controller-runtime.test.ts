import { mkdir, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  planReconciliation,
  type ReconciliationInput,
  type ReconciliationResult,
} from "../../../packages/delivery-ctl/src/reconcile.js";
import {
  resolvePaperclipRoutineContract,
  type PaperclipRoutineContract,
} from "../../../packages/delivery-ctl/src/paperclip-routines.js";
import {
  ControllerRuntimeError,
  runControllerRuntime,
  writeManagedReconciliationEvidence,
  type ManagedReconciliationExecutor,
} from "./controller-runtime.js";

const agentId = "10000000-0000-4000-8000-000000000001";
const companyId = "20000000-0000-4000-8000-000000000002";
const heartbeatRunId = "30000000-0000-4000-8000-000000000003";
const projectId = "40000000-0000-4000-8000-000000000004";
const issueId = "50000000-0000-4000-8000-000000000005";
const routineId = "60000000-0000-4000-8000-000000000006";
const routineRunId = "70000000-0000-4000-8000-000000000007";
const triggerId = "80000000-0000-4000-8000-000000000008";
const token = `paperclip_${"controller".repeat(4)}`;
const evidenceDigest = `sha256:${"a".repeat(64)}`;

const environment = {
  PAPERCLIP_API_URL: "http://127.0.0.1:3100",
  PAPERCLIP_API_KEY: token,
  PAPERCLIP_AGENT_ID: agentId,
  PAPERCLIP_COMPANY_ID: companyId,
  PAPERCLIP_RUN_ID: heartbeatRunId,
};

const routineContract = JSON.parse(
  await readFile(new URL("../../../routines/nightly-reconciliation.json", import.meta.url), "utf8"),
) as PaperclipRoutineContract;
const resolvedRoutine = resolvePaperclipRoutineContract("Private", routineContract);

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

function assignment(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: issueId,
    companyId,
    projectId,
    title: resolvedRoutine.title,
    description: resolvedRoutine.description,
    status: "in_progress",
    priority: "low",
    assigneeAgentId: agentId,
    executionRunId: heartbeatRunId,
    originKind: "routine_execution",
    originId: routineId,
    originRunId: routineRunId,
    ...overrides,
  };
}

function routine(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: routineId,
    companyId,
    projectId,
    folderId: null,
    goalId: null,
    parentIssueId: null,
    title: resolvedRoutine.title,
    description: resolvedRoutine.description,
    assigneeAgentId: agentId,
    priority: "low",
    status: "active",
    concurrencyPolicy: "coalesce_if_active",
    catchUpPolicy: "skip_missed",
    variables: [],
    triggers: [{
      id: triggerId,
      kind: "schedule",
      label: resolvedRoutine.trigger.label,
      enabled: true,
      cronExpression: resolvedRoutine.trigger.cronExpression,
      timezone: resolvedRoutine.trigger.timezone,
    }],
    ...overrides,
  };
}

function routineRun(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: routineRunId,
    companyId,
    routineId,
    triggerId,
    source: "schedule",
    status: "issue_created",
    linkedIssueId: issueId,
    completedAt: null,
    ...overrides,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface ObservedRequest {
  readonly path: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly runId: string | null;
  readonly body: unknown;
}

function fetchFor(
  assignments: readonly unknown[],
  observed: ObservedRequest[] = [],
  routineValue: unknown = routine(),
  runsValue: unknown = [routineRun()],
): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    observed.push({
      path: `${url.pathname}${url.search}`,
      method,
      authorization: new Headers(init?.headers).get("authorization"),
      runId: new Headers(init?.headers).get("x-paperclip-run-id"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : null,
    });
    if (url.pathname === "/api/agents/me") return jsonResponse(identity());
    if (url.pathname.endsWith("/issues") && method === "GET") {
      expect(url.searchParams.get("assigneeAgentId")).toBe(agentId);
      return jsonResponse(assignments);
    }
    if (url.pathname === `/api/routines/${routineId}`) return jsonResponse(routineValue);
    if (url.pathname === `/api/routines/${routineId}/runs`) {
      expect(url.searchParams.get("limit")).toBe("50");
      return jsonResponse(runsValue);
    }
    if (url.pathname === `/api/issues/${issueId}` && method === "PATCH") {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
      return jsonResponse({ id: issueId, companyId, status: body["status"] });
    }
    return jsonResponse({ error: "not found" }, 404);
  };
}

function executor(status: Exclude<ReconciliationResult["status"], "planned">): ManagedReconciliationExecutor {
  return vi.fn(async (input: ReconciliationInput) => ({
    ...planReconciliation(input),
    status,
    evidenceDigest,
  }));
}

function evidence() {
  const queue = { ready: 0, overdue: 0, staleClaims: 0, deadLettered: 0 };
  return {
    schemaVersion: 1 as const,
    observedAt: "2026-07-29T00:00:00.000Z",
    status: "compliant" as const,
    controller: "maxbec-delivery-controller" as const,
    mode: "read_only" as const,
    database: {
      status: "compliant" as const,
      activeBindings: 1,
      inbox: queue,
      outbox: queue,
      authorizations: {
        active: 0,
        expiring: 0,
        expiredUnpublished: 0,
        bindingDrift: 0,
        missingOutbox: 0,
        publicationMismatch: 0,
        overdueWithoutAuthorization: 0,
      },
      integrity: { completedWithoutTransition: 0, outboxScopeMismatch: 0, deadLetterMismatch: 0 },
    },
    paperclip: {
      status: "not_applicable" as const,
      checkedCases: 0,
      scopeDrift: 0,
      missingTransitionEvidence: 0,
      unrecordedTransitionEvidence: 0,
      stateConflict: 0,
    },
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

  it("runs only the exact schedule-bound routine issue and emits a digest-only completion", async () => {
    const observed: ObservedRequest[] = [];
    const reconcile = executor("compliant");
    const result = await runControllerRuntime(
      environment,
      process.cwd(),
      fetchFor([assignment()], observed),
      reconcile,
    );

    expect(reconcile).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledWith({
      schemaVersion: 1,
      company: { id: companyId, name: "Private" },
      controller: "maxbec-delivery-controller",
      controls: {
        queueLagSeconds: 900,
        staleClaimSeconds: 300,
        authorizationExpiryWarningSeconds: 300,
        lookbackSeconds: 172800,
        maximumAuthorizationRecords: 500,
      },
      mutationAllowed: false,
    }, environment, heartbeatRunId);
    expect(observed.at(-1)).toMatchObject({
      path: `/api/issues/${issueId}`,
      method: "PATCH",
      authorization: `Bearer ${token}`,
      runId: heartbeatRunId,
      body: {
        status: "done",
        comment: `Read-only reconciliation completed. Evidence digest: ${evidenceDigest}.`,
      },
    });
    expect(result).toMatchObject({ schemaVersion: 1, status: "compliant", evidenceDigest });
    expect(JSON.stringify(result)).not.toContain(agentId);
    expect(JSON.stringify(result)).not.toContain(companyId);
    expect(JSON.stringify(result)).not.toContain(issueId);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("routes non-compliant evidence to review without exposing audit details", async () => {
    const observed: ObservedRequest[] = [];
    const result = await runControllerRuntime(
      environment,
      process.cwd(),
      fetchFor([assignment()], observed),
      executor("attention"),
    );

    expect(observed.at(-1)?.body).toEqual({
      status: "in_review",
      comment: `Read-only reconciliation requires review (attention). Evidence digest: ${evidenceDigest}.`,
    });
    expect(result).toMatchObject({ status: "attention", evidenceDigest });
  });

  it("writes private reconciliation evidence create-only outside the checkout", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "flama-controller-evidence-"));
    const evidenceDirectory = join(temporaryRoot, "evidence");
    const linkedDirectory = join(temporaryRoot, "linked");
    await mkdir(evidenceDirectory);
    try {
      await writeManagedReconciliationEvidence(
        { FLAMA_RECONCILIATION_EVIDENCE_DIR: evidenceDirectory },
        heartbeatRunId,
        evidence(),
      );
      const output = join(evidenceDirectory, `reconciliation-${heartbeatRunId}.json`);
      expect((await stat(output)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(output, "utf8"))).toEqual(evidence());
      await expect(writeManagedReconciliationEvidence(
        { FLAMA_RECONCILIATION_EVIDENCE_DIR: evidenceDirectory },
        heartbeatRunId,
        evidence(),
      )).rejects.toMatchObject({ code: "controller_evidence_unavailable" });

      await symlink(evidenceDirectory, linkedDirectory, "dir");
      await expect(writeManagedReconciliationEvidence(
        { FLAMA_RECONCILIATION_EVIDENCE_DIR: linkedDirectory },
        "90000000-0000-4000-8000-000000000009",
        evidence(),
      )).rejects.toMatchObject({ code: "controller_evidence_unavailable" });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("fails closed before executing an arbitrary assignment", async () => {
    const reconcile = executor("compliant");
    await expect(
      runControllerRuntime(
        environment,
        process.cwd(),
        fetchFor([assignment({ originKind: "manual" })]),
        reconcile,
      ),
    ).rejects.toEqual(expect.objectContaining<Partial<ControllerRuntimeError>>({
      code: "controller_assignment_unsupported",
    }));
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("rejects routine and run drift before executing or patching the issue", async () => {
    const observed: ObservedRequest[] = [];
    const reconcile = executor("compliant");
    await expect(
      runControllerRuntime(
        environment,
        process.cwd(),
        fetchFor([assignment()], observed, routine({ status: "paused" })),
        reconcile,
      ),
    ).rejects.toEqual(expect.objectContaining<Partial<ControllerRuntimeError>>({ code: "controller_routine_drift" }));
    expect(reconcile).not.toHaveBeenCalled();
    expect(observed.some((request) => request.method === "PATCH")).toBe(false);

    observed.length = 0;
    await expect(
      runControllerRuntime(
        environment,
        process.cwd(),
        fetchFor([assignment()], observed, routine(), [routineRun({ source: "manual" })]),
        reconcile,
      ),
    ).rejects.toEqual(expect.objectContaining<Partial<ControllerRuntimeError>>({ code: "controller_routine_drift" }));
    expect(reconcile).not.toHaveBeenCalled();
    expect(observed.some((request) => request.method === "PATCH")).toBe(false);
  });

  it("rejects unbound reconciliation output before patching the issue", async () => {
    const observed: ObservedRequest[] = [];
    const invalidExecutor: ManagedReconciliationExecutor = async (input) => ({
      ...planReconciliation(input),
      status: "compliant",
      contractDigest: `sha256:${"b".repeat(64)}`,
      evidenceDigest,
    });
    await expect(runControllerRuntime(
      environment,
      process.cwd(),
      fetchFor([assignment()], observed),
      invalidExecutor,
    )).rejects.toMatchObject({ code: "controller_reconciliation_failed" });
    expect(observed.some((request) => request.method === "PATCH")).toBe(false);
  });

  it("rejects identity drift and suppresses upstream bodies and credentials", async () => {
    const mismatchedFetch: typeof fetch = async () => jsonResponse({
      ...identity(),
      budgetMonthlyCents: 1,
    });
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
