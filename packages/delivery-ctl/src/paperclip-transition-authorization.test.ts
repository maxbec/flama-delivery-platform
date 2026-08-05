import { describe, expect, it } from "vitest";
import {
  applyPaperclipTransitionAuthorization,
  type PaperclipTransitionAuthorizationInput,
  planPaperclipTransitionAuthorization,
  type TransitionAuthorizationWriter,
} from "./paperclip-transition-authorization.js";

const now = new Date("2026-07-29T07:00:00.000Z");

function input(): PaperclipTransitionAuthorizationInput {
  return {
    schemaVersion: 1,
    company: "Private",
    controller: "maxbec-delivery-controller",
    deliveryId: "delivery-authorization-1",
    transitionKind: "pull_request.opened",
    bindingDigest: `sha256:${"a".repeat(64)}`,
    evidenceDigest: `sha256:${"b".repeat(64)}`,
    case: {
      id: "10000000-0000-4000-8000-000000000001",
      pipelineId: "20000000-0000-4000-8000-000000000002",
      pipelineKey: "flama-feature-fix-v1",
      fromStageKey: "preflight_passed",
      toStageKey: "pr_open",
    },
    authorizedAt: "2026-07-29T06:59:00.000Z",
    expiresAt: "2026-07-29T07:30:00.000Z",
    mutationAllowed: true,
  };
}

describe("Paperclip transition authorization", () => {
  it("plans one exact lifecycle edge without exposing identifiers", () => {
    const result = planPaperclipTransitionAuthorization(input(), now);

    expect(result).toEqual({
      schemaVersion: 1,
      status: "planned",
      disposition: "planned",
      authorizationDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    expect(JSON.stringify(result)).not.toContain("delivery-authorization-1");
    expect(JSON.stringify(result)).not.toContain("10000000-0000-4000-8000-000000000001");
  });

  it("returns only a digest after a deterministic writer succeeds", async () => {
    const value = input();
    const writer: TransitionAuthorizationWriter = {
      async write(request) {
        return {
          disposition: "created",
          record: {
            idempotencyKey: `github:${request.deliveryId}:${request.transitionKind}`,
            repositoryName: "maxbec/api",
            company: request.company,
            controllerName: request.controller,
            caseId: request.case.id,
            pipelineId: request.case.pipelineId,
            pipelineKey: request.case.pipelineKey,
            transitionKind: request.transitionKind,
            fromStageKey: request.case.fromStageKey,
            toStageKey: request.case.toStageKey,
            eventDigest: `sha256:${"c".repeat(64)}`,
            evidenceDigest: request.evidenceDigest,
            bindingDigest: request.bindingDigest,
            authorizedAt: request.authorizedAt,
            expiresAt: request.expiresAt,
          },
        };
      },
    };

    const result = await applyPaperclipTransitionAuthorization(value, writer, now);

    expect(result.status).toBe("applied");
    expect(result.disposition).toBe("created");
    expect(JSON.stringify(result)).not.toContain("maxbec/api");
    expect(JSON.stringify(result)).not.toContain(value.case.id);
  });

  it("rejects controller mismatch, stale authorization, and unpinned edges", () => {
    expect(() => planPaperclipTransitionAuthorization({
      ...input(),
      controller: "edilio-delivery-controller",
    }, now)).toThrowError(expect.objectContaining({ code: "authorization_scope_invalid" }));
    expect(() => planPaperclipTransitionAuthorization({
      ...input(),
      authorizedAt: "2026-07-29T06:00:00.000Z",
    }, now)).toThrowError(expect.objectContaining({ code: "authorization_scope_invalid" }));
    expect(() => planPaperclipTransitionAuthorization({
      ...input(),
      case: { ...input().case, toStageKey: "done" },
    }, now)).toThrowError(expect.objectContaining({ code: "authorization_scope_invalid" }));
  });
});
