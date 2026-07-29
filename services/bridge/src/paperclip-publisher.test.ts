import { createHash } from "node:crypto";
import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import type { PaperclipTransitionMessage } from "./processor.js";
import {
  AuthorizedPaperclipPublisher,
  PaperclipPublicationError,
  PaperclipRestTransitionApi,
  minimizedEventDigest,
  parsePaperclipPublisherConfig,
  type AuthorizedTransition,
  type PaperclipCaseDetail,
  type PaperclipTransitionApi,
  type PaperclipTransitionEvent,
  type TransitionAuthorizationStore,
} from "./paperclip-publisher.js";

const companyId = "10000000-0000-4000-8000-000000000001";
const caseId = "20000000-0000-4000-8000-000000000002";
const pipelineId = "30000000-0000-4000-8000-000000000003";
const sha = "a".repeat(40);

function featureMessage(headRef = "feature/verified-change"): PaperclipTransitionMessage {
  const transitionKind = "pull_request.opened";
  return {
    idempotencyKey: `github:delivery-1:${transitionKind}`,
    deliveryId: "delivery-1",
    company: "Private",
    transitionKind,
    payload: {
      schemaVersion: 1,
      eventName: "pull_request",
      action: "opened",
      repository: "maxbec/api",
      repositoryId: 101,
      pullRequest: {
        number: 7,
        state: "open",
        merged: false,
        headSha: sha,
        headRef,
        baseRef: "main",
        mergeSha: null,
        url: "https://github.com/maxbec/api/pull/7",
      },
    },
  };
}

function authorization(
  message: PaperclipTransitionMessage,
  overrides: Partial<AuthorizedTransition> = {},
): AuthorizedTransition {
  return {
    idempotencyKey: message.idempotencyKey,
    repository: "maxbec/api",
    company: "Private",
    controllerName: "maxbec-delivery-controller",
    caseId,
    pipelineId,
    pipelineKey: "flama-feature-fix-v1",
    transitionKind: message.transitionKind,
    fromStageKey: "preflight_passed",
    toStageKey: "pr_open",
    eventDigest: minimizedEventDigest(message.payload),
    evidenceDigest: `sha256:${"b".repeat(64)}`,
    bindingDigest: `sha256:${"c".repeat(64)}`,
    defaultBranch: "main",
    alreadyPublished: false,
    ...overrides,
  };
}

class MemoryAuthorizationStore implements TransitionAuthorizationStore {
  readonly marked: string[] = [];

  constructor(readonly value: AuthorizedTransition | undefined) {}

  async resolve(): Promise<AuthorizedTransition | undefined> {
    return this.value;
  }

  async markPublished(idempotencyKey: string): Promise<void> {
    this.marked.push(idempotencyKey);
  }
}

class MemoryPaperclipApi implements PaperclipTransitionApi {
  readonly transitions: Array<{ caseId: string; input: { toStageKey: string; expectedVersion: number; reason: string } }> = [];
  readonly calls: string[] = [];

  constructor(
    private detail: PaperclipCaseDetail,
    readonly events: readonly PaperclipTransitionEvent[] = [],
  ) {}

  async getCase(requestedCaseId: string): Promise<PaperclipCaseDetail> {
    this.calls.push(`get:${requestedCaseId}`);
    return this.detail;
  }

  async listCaseEvents(requestedCaseId: string): Promise<readonly PaperclipTransitionEvent[]> {
    this.calls.push(`events:${requestedCaseId}`);
    return this.events;
  }

  async transitionCase(requestedCaseId: string, input: {
    readonly toStageKey: string;
    readonly expectedVersion: number;
    readonly reason: string;
  }): Promise<void> {
    this.calls.push(`transition:${requestedCaseId}`);
    this.transitions.push({ caseId: requestedCaseId, input });
    this.detail = { ...this.detail, stageKey: input.toStageKey, version: input.expectedVersion + 1 };
  }
}

function caseDetail(stageKey = "preflight_passed"): PaperclipCaseDetail {
  return {
    caseId,
    companyId,
    pipelineId,
    pipelineKey: "flama-feature-fix-v1",
    stageKey,
    version: 4,
    terminalKind: null,
  };
}

describe("authorized Paperclip publication", () => {
  it("moves only the exact authorized case with optimistic concurrency", async () => {
    const message = featureMessage();
    const store = new MemoryAuthorizationStore(authorization(message));
    const api = new MemoryPaperclipApi(caseDetail());
    const publisher = new AuthorizedPaperclipPublisher("Private", companyId, store, api);

    await expect(publisher.publish(message)).resolves.toBeUndefined();

    expect(api.transitions).toHaveLength(1);
    expect(api.transitions[0]).toMatchObject({
      caseId,
      input: { toStageKey: "pr_open", expectedVersion: 4 },
    });
    expect(api.transitions[0]?.input.reason).toMatch(/^flama-external:sha256:[0-9a-f]{64}$/u);
    expect(store.marked).toEqual([message.idempotencyKey]);
  });

  it("fails closed when no exact controller authorization exists", async () => {
    const message = featureMessage();
    const store = new MemoryAuthorizationStore(undefined);
    const api = new MemoryPaperclipApi(caseDetail());
    const publisher = new AuthorizedPaperclipPublisher("Private", companyId, store, api);

    await expect(publisher.publish(message)).rejects.toMatchObject({ code: "authorization_missing" });
    expect(api.calls).toEqual([]);
  });

  it("rejects a deployment branch as feature-case evidence", async () => {
    const message = featureMessage("deploy/v1.0.0");
    const store = new MemoryAuthorizationStore(authorization(message));
    const api = new MemoryPaperclipApi(caseDetail());
    const publisher = new AuthorizedPaperclipPublisher("Private", companyId, store, api);

    await expect(publisher.publish(message)).rejects.toMatchObject({ code: "event_evidence_invalid" });
    expect(api.calls).toEqual([]);
  });

  it("rejects authorization for an edge outside the pinned lifecycle", async () => {
    const message = featureMessage();
    const store = new MemoryAuthorizationStore(authorization(message, { toStageKey: "done" }));
    const api = new MemoryPaperclipApi(caseDetail());
    const publisher = new AuthorizedPaperclipPublisher("Private", companyId, store, api);

    await expect(publisher.publish(message)).rejects.toMatchObject({ code: "authorization_scope_mismatch" });
    expect(api.calls).toEqual([]);
  });

  it("recognizes a prior exact transition after a crash without repeating it", async () => {
    const message = featureMessage();
    const digest = createHash("sha256").update(message.idempotencyKey).digest("hex");
    const api = new MemoryPaperclipApi(caseDetail("pr_open"), [{
      type: "transitioned",
      fromStageKey: "preflight_passed",
      toStageKey: "pr_open",
      reason: `flama-external:sha256:${digest}`,
    }]);
    const store = new MemoryAuthorizationStore(authorization(message));
    const publisher = new AuthorizedPaperclipPublisher("Private", companyId, store, api);

    await expect(publisher.publish(message)).resolves.toBeUndefined();
    expect(api.transitions).toEqual([]);
    expect(store.marked).toEqual([message.idempotencyKey]);
  });

  it("does not confuse an unrelated transition to the same target for a retry", async () => {
    const message = featureMessage();
    const api = new MemoryPaperclipApi(caseDetail("pr_open"), [{
      type: "transitioned",
      fromStageKey: "preflight_passed",
      toStageKey: "pr_open",
      reason: "unrelated",
    }]);
    const publisher = new AuthorizedPaperclipPublisher(
      "Private",
      companyId,
      new MemoryAuthorizationStore(authorization(message)),
      api,
    );

    await expect(publisher.publish(message)).rejects.toMatchObject({ code: "paperclip_state_conflict" });
  });

  it("short-circuits a locally recorded publication", async () => {
    const message = featureMessage();
    const store = new MemoryAuthorizationStore(authorization(message, { alreadyPublished: true }));
    const api = new MemoryPaperclipApi(caseDetail());
    const publisher = new AuthorizedPaperclipPublisher("Private", companyId, store, api);

    await expect(publisher.publish(message)).resolves.toBeUndefined();
    expect(api.calls).toEqual([]);
    expect(store.marked).toEqual([]);
  });

  it("rejects cross-company publication before any Paperclip call", async () => {
    const message = { ...featureMessage(), company: "Edilio" as const };
    const store = new MemoryAuthorizationStore(authorization(message));
    const api = new MemoryPaperclipApi(caseDetail());
    const publisher = new AuthorizedPaperclipPublisher("Private", companyId, store, api);

    await expect(publisher.publish(message)).rejects.toMatchObject({ code: "authorization_scope_mismatch" });
    expect(api.calls).toEqual([]);
  });

  it("does not expose rejected values through publication errors", () => {
    const sensitive = "sensitive-value-that-must-not-escape";
    expect(() => parsePaperclipPublisherConfig({
      PAPERCLIP_API_URL: sensitive,
      PAPERCLIP_API_KEY: "x".repeat(32),
    })).toThrowError(new PaperclipPublicationError("paperclip_identity_unavailable"));
    try {
      parsePaperclipPublisherConfig({ PAPERCLIP_API_URL: sensitive, PAPERCLIP_API_KEY: "x".repeat(32) });
    } catch (error) {
      expect(String(error)).not.toContain(sensitive);
    }
  });

  it("keeps the Paperclip API key redacted under inspection and JSON encoding", () => {
    const apiKey = "test-only-paperclip-key-value";
    const config = parsePaperclipPublisherConfig({
      PAPERCLIP_API_URL: "https://paperclip.example.invalid",
      PAPERCLIP_API_KEY: apiKey,
    });

    expect(inspect(config)).not.toContain(apiKey);
    expect(JSON.stringify(config)).not.toContain(apiKey);
  });
});

describe("Paperclip REST transition API", () => {
  const environment = {
    PAPERCLIP_API_URL: "https://paperclip.example.invalid",
    PAPERCLIP_API_KEY: "test-only-paperclip-key-value",
  };

  it("validates case identity and uses only the documented transition endpoint", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImplementation = vi.fn(async (input: string | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      if (String(input).endsWith(`/api/cases/${caseId}`)) {
        return Response.json({
          case: { id: caseId, companyId, pipelineId, version: 5, terminalKind: null },
          stage: { id: "40000000-0000-4000-8000-000000000004", key: "preflight_passed" },
          pipeline: { id: pipelineId, companyId, key: "flama-feature-fix-v1" },
        });
      }
      return Response.json({ case: { id: caseId, version: 6 } });
    });
    const api = new PaperclipRestTransitionApi(environment, fetchImplementation);

    await expect(api.getCase(caseId)).resolves.toMatchObject({
      caseId,
      companyId,
      pipelineId,
      pipelineKey: "flama-feature-fix-v1",
      stageKey: "preflight_passed",
      version: 5,
    });
    await expect(api.transitionCase(caseId, {
      toStageKey: "pr_open",
      expectedVersion: 5,
      reason: `flama-external:sha256:${"d".repeat(64)}`,
    })).resolves.toBeUndefined();

    expect(requests.map(({ url }) => url)).toEqual([
      `https://paperclip.example.invalid/api/cases/${caseId}`,
      `https://paperclip.example.invalid/api/cases/${caseId}/transition`,
    ]);
    expect(requests[1]?.init?.method).toBe("POST");
    expect(requests[1]?.init?.headers).toMatchObject({
      authorization: `Bearer ${environment.PAPERCLIP_API_KEY}`,
      "content-type": "application/json",
    });
  });

  it("paginates event history for crash-safe idempotency", async () => {
    const fetchImplementation = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      const offset = Number(url.searchParams.get("offset"));
      if (offset === 0) {
        return Response.json({
          items: Array.from({ length: 100 }, () => ({ type: "updated", payload: {}, fromStage: null, toStage: null })),
          pagination: { hasMore: true, nextOffset: 100 },
        });
      }
      return Response.json({
        items: [{
          type: "transitioned",
          fromStage: { key: "preflight_passed" },
          toStage: { key: "pr_open" },
          payload: { reason: `flama-external:sha256:${"e".repeat(64)}` },
        }],
        pagination: { hasMore: false, nextOffset: null },
      });
    });
    const api = new PaperclipRestTransitionApi(environment, fetchImplementation);

    const events = await api.listCaseEvents(caseId);

    expect(events).toHaveLength(101);
    expect(events.at(-1)).toEqual({
      type: "transitioned",
      fromStageKey: "preflight_passed",
      toStageKey: "pr_open",
      reason: `flama-external:sha256:${"e".repeat(64)}`,
    });
  });

  it("suppresses Paperclip response bodies on failure", async () => {
    const fetchImplementation = vi.fn(async () => new Response(
      JSON.stringify({ error: "sensitive-response-value" }),
      { status: 500, headers: { "content-type": "application/json" } },
    ));
    const api = new PaperclipRestTransitionApi(environment, fetchImplementation);

    try {
      await api.getCase(caseId);
      throw new Error("expected publication to fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "paperclip_unavailable" });
      expect(String(error)).not.toContain("sensitive-response-value");
    }
  });
});
