import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  auditReconciliation,
  PaperclipReadOnlyReconciliationReader,
  planReconciliation,
  ReconciliationError,
  type ReconciliationAuthorization,
  type ReconciliationDatabaseSnapshot,
  type ReconciliationInput,
  type ReconciliationPaperclipReader,
} from "./reconcile.js";

const companyId = "10000000-0000-4000-8000-000000000001";
const caseId = "20000000-0000-4000-8000-000000000002";
const pipelineId = "30000000-0000-4000-8000-000000000003";
const credential = "test-only-reconciliation-paperclip-key";
const observedAt = new Date("2026-07-29T01:17:00.000Z");

const input: ReconciliationInput = {
  schemaVersion: 1,
  company: { id: companyId, name: "Private" },
  controller: "maxbec-delivery-controller",
  controls: {
    queueLagSeconds: 900,
    staleClaimSeconds: 300,
    authorizationExpiryWarningSeconds: 300,
    lookbackSeconds: 172_800,
    maximumAuthorizationRecords: 500,
  },
  mutationAllowed: false,
};

function authorization(published = true): ReconciliationAuthorization {
  return {
    idempotencyKey: "github:test-delivery:pull_request.merged",
    caseId,
    pipelineId,
    pipelineKey: "flama-feature-fix-v1",
    fromStageKey: "pr_open",
    toStageKey: "merged",
    published,
  };
}

function emptySnapshot(overrides: Partial<ReconciliationDatabaseSnapshot> = {}): ReconciliationDatabaseSnapshot {
  return {
    activeBindings: 1,
    inbox: { ready: 0, overdue: 0, staleClaims: 0, deadLettered: 0 },
    outbox: { ready: 0, overdue: 0, staleClaims: 0, deadLettered: 0 },
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
    authorizationRecords: [],
    ...overrides,
  };
}

function transitionReason(record: ReconciliationAuthorization): string {
  return `flama-external:sha256:${createHash("sha256").update(record.idempotencyKey).digest("hex")}`;
}

function paperclipReader(record: ReconciliationAuthorization): ReconciliationPaperclipReader {
  return {
    async getCase() {
      return {
        caseId,
        companyId,
        pipelineId,
        pipelineKey: record.pipelineKey,
        stageKey: record.toStageKey,
        terminalKind: null,
      };
    },
    async listCaseEvents() {
      return [{
        type: "transitioned",
        fromStageKey: record.fromStageKey,
        toStageKey: record.toStageKey,
        reason: transitionReason(record),
      }];
    },
  };
}

describe("read-only reconciliation audit", () => {
  it("plans without requesting identities or exposing company IDs", () => {
    const result = planReconciliation(input);

    expect(result).toMatchObject({
      schemaVersion: 1,
      status: "planned",
      controller: "maxbec-delivery-controller",
      mode: "read_only",
    });
    expect(result.contractDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(JSON.stringify(result)).not.toContain(companyId);
  });

  it("verifies database and Paperclip transition evidence without emitting object identifiers", async () => {
    const record = authorization();
    const audit = await auditReconciliation(input, {
      database: { async read() { return emptySnapshot({ authorizationRecords: [record] }); } },
      paperclip: paperclipReader(record),
    }, observedAt);

    expect(audit.result).toMatchObject({ status: "compliant", mode: "read_only" });
    expect(audit.result.evidenceDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(audit.evidence).toMatchObject({
      status: "compliant",
      database: { status: "compliant", activeBindings: 1 },
      paperclip: { status: "compliant", checkedCases: 1 },
    });
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain(companyId);
    expect(serialized).not.toContain(caseId);
    expect(serialized).not.toContain(pipelineId);
    expect(serialized).not.toContain("test-delivery");
  });

  it("reports queue drift, missing Paperclip evidence, and absent bindings without mutation", async () => {
    const record = authorization();
    const attention = await auditReconciliation(input, {
      database: {
        async read() {
          return emptySnapshot({
            inbox: { ready: 1, overdue: 1, staleClaims: 0, deadLettered: 0 },
            authorizationRecords: [record],
          });
        },
      },
      paperclip: {
        async getCase() {
          return {
            caseId,
            companyId,
            pipelineId,
            pipelineKey: record.pipelineKey,
            stageKey: record.toStageKey,
            terminalKind: null,
          };
        },
        async listCaseEvents() { return []; },
      },
    }, observedAt);
    expect(attention.result.status).toBe("attention");
    expect(attention.evidence.paperclip.missingTransitionEvidence).toBe(1);

    const insufficient = await auditReconciliation(input, {
      database: { async read() { return emptySnapshot({ activeBindings: 0 }); } },
      paperclip: paperclipReader(record),
    }, observedAt);
    expect(insufficient.result.status).toBe("insufficient_data");
  });

  it("fails closed instead of partially auditing an oversized authorization set", async () => {
    const constrained = {
      ...input,
      controls: { ...input.controls, maximumAuthorizationRecords: 1 },
    } satisfies ReconciliationInput;
    await expect(auditReconciliation(constrained, {
      database: {
        async read() {
          return emptySnapshot({ authorizationRecords: [authorization(), authorization(false)] });
        },
      },
      paperclip: paperclipReader(authorization()),
    }, observedAt)).rejects.toEqual(expect.objectContaining<Partial<ReconciliationError>>({
      code: "reconciliation_scope_too_large",
    }));
  });

  it("uses a hard GET-only Paperclip transport and suppresses credentials and response bodies", async () => {
    const methods: string[] = [];
    const reader = new PaperclipReadOnlyReconciliationReader({
      PAPERCLIP_API_URL: "http://127.0.0.1:3100",
      PAPERCLIP_API_KEY: credential,
    }, async (request, init) => {
      methods.push(init?.method ?? "");
      expect(init?.headers).toMatchObject({ Authorization: `Bearer ${credential}` });
      const url = new URL(request instanceof Request ? request.url : request);
      if (url.pathname.endsWith("/events")) {
        return Response.json({ items: [], pagination: { hasMore: false, nextOffset: null } });
      }
      return Response.json({
        case: { id: caseId, companyId, pipelineId, terminalKind: null },
        stage: { key: "pr_open" },
        pipeline: { id: pipelineId, companyId, key: "flama-feature-fix-v1" },
      });
    });
    await reader.getCase(caseId);
    await reader.listCaseEvents(caseId);
    expect(methods).toEqual(["GET", "GET"]);

    const privateBody = `private upstream response ${credential}`;
    let caught: unknown;
    try {
      await new PaperclipReadOnlyReconciliationReader({
        PAPERCLIP_API_URL: "http://127.0.0.1:3100",
        PAPERCLIP_API_KEY: credential,
      }, async () => new Response(privateBody, { status: 500 })).getCase(caseId);
    } catch (error) {
      caught = error;
    }
    expect(caught).toEqual(expect.objectContaining<Partial<ReconciliationError>>({
      code: "reconciliation_read_failed",
    }));
    expect(String(caught)).not.toContain(credential);
    expect(JSON.stringify(caught)).not.toContain(privateBody);
  });
});
