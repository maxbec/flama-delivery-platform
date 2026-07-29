import { describe, expect, it } from "vitest";
import type {
  ClaimedTransition,
  ClaimedWebhook,
  DeliveryFailure,
  Transition,
  TransitionFailure,
} from "./inbox.js";
import {
  processNextTransition,
  processNextWebhook,
  type PaperclipPublisher,
  type TransitionQueue,
  type WebhookQueue,
} from "./processor.js";
import type { RepositoryScope } from "./repository-scope.js";

const sha = "b".repeat(40);
const allowedScope: RepositoryScope = { async allows() { return true; } };

class MemoryWebhookQueue implements WebhookQueue {
  transition?: Transition;
  failure?: DeliveryFailure;

  constructor(private claim: ClaimedWebhook | undefined) {}

  async claimNext(): Promise<ClaimedWebhook | undefined> {
    const claimed = this.claim;
    this.claim = undefined;
    return claimed;
  }

  async completeWithTransition(transition: Transition): Promise<void> {
    this.transition = transition;
  }

  async fail(failure: DeliveryFailure): Promise<"retry_scheduled" | "dead_lettered"> {
    this.failure = failure;
    return "dead_lettered";
  }
}

class MemoryTransitionQueue implements TransitionQueue {
  publishedId?: string;
  failure?: TransitionFailure;

  constructor(private claim: ClaimedTransition | undefined) {}

  async claimNextTransition(): Promise<ClaimedTransition | undefined> {
    const claimed = this.claim;
    this.claim = undefined;
    return claimed;
  }

  async markTransitionPublished(id: string): Promise<void> {
    this.publishedId = id;
  }

  async failTransition(failure: TransitionFailure): Promise<"retry_scheduled" | "dead_lettered"> {
    this.failure = failure;
    return "retry_scheduled";
  }
}

describe("bridge workers", () => {
  it("routes a minimized GitHub event to the owner company", async () => {
    const queue = new MemoryWebhookQueue({
      deliveryId: "delivery-10",
      eventName: "pull_request",
      owner: "maxbec",
      repository: "maxbec/api",
      payload: {
        schemaVersion: 1,
        eventName: "pull_request",
        action: "closed",
        repository: "maxbec/api",
        repositoryId: 101,
        pullRequest: {
          number: 7,
          state: "closed",
          merged: true,
          headSha: sha,
          headRef: "feature/verified-change",
          baseRef: "main",
          mergeSha: sha,
          url: "https://github.com/maxbec/api/pull/7",
        },
      },
      receivedAt: new Date("2026-07-28T20:00:00Z"),
      attempts: 1,
    });

    await expect(processNextWebhook(queue, allowedScope, "worker-a")).resolves.toBe("completed");
    expect(queue.transition).toEqual({
      deliveryId: "delivery-10",
      company: "Private",
      transitionKind: "pull_request.merged",
      payload: expect.objectContaining({ repository: "maxbec/api" }),
    });
  });

  it("dead-letters non-minimized legacy payloads without reflecting them", async () => {
    const queue = new MemoryWebhookQueue({
      deliveryId: "delivery-11",
      eventName: "pull_request",
      owner: "maxbec",
      repository: "maxbec/api",
      payload: { body: "sensitive-value" },
      receivedAt: new Date("2026-07-28T20:00:00Z"),
      attempts: 1,
    });

    await expect(processNextWebhook(queue, allowedScope, "worker-a")).resolves.toBe("failed");
    expect(queue.failure).toEqual({
      deliveryId: "delivery-11",
      maxAttempts: 1,
      reasonCode: "invalid_minimized_event",
    });
    expect(JSON.stringify(queue.failure)).not.toContain("sensitive-value");
  });

  it("rejects extra fields even when the minimized evidence is otherwise valid", async () => {
    const queue = new MemoryWebhookQueue({
      deliveryId: "delivery-11-extra",
      eventName: "pull_request",
      owner: "maxbec",
      repository: "maxbec/api",
      payload: {
        schemaVersion: 1,
        eventName: "pull_request",
        action: "closed",
        repository: "maxbec/api",
        repositoryId: 101,
        pullRequest: {
          number: 7,
          state: "closed",
          merged: true,
          headSha: sha,
          headRef: "feature/verified-change",
          baseRef: "main",
          mergeSha: sha,
          url: "https://github.com/maxbec/api/pull/7",
          body: "sensitive-value",
        },
      },
      receivedAt: new Date("2026-07-28T20:00:00Z"),
      attempts: 1,
    });

    await expect(processNextWebhook(queue, allowedScope, "worker-a")).resolves.toBe("failed");
    expect(queue.transition).toBeUndefined();
    expect(queue.failure?.reasonCode).toBe("invalid_minimized_event");
  });

  it("rechecks repository binding before creating a transition", async () => {
    const queue = new MemoryWebhookQueue({
      deliveryId: "delivery-scope-denied",
      eventName: "push",
      owner: "edilio",
      repository: "edilio/plugin",
      payload: {
        schemaVersion: 1,
        eventName: "push",
        action: "updated",
        repository: "edilio/plugin",
        repositoryId: 205,
        push: { ref: "refs/heads/main", before: sha, after: "c".repeat(40), created: false, deleted: false, forced: false },
      },
      receivedAt: new Date("2026-07-28T20:00:00Z"),
      attempts: 1,
    });
    const deniedScope: RepositoryScope = { async allows() { return false; } };

    await expect(processNextWebhook(queue, deniedScope, "worker-a")).resolves.toBe("failed");
    expect(queue.transition).toBeUndefined();
    expect(queue.failure).toEqual({
      deliveryId: "delivery-scope-denied",
      reasonCode: "repository_scope_denied",
      maxAttempts: 1,
    });
  });

  it("publishes with a deterministic idempotency key then marks the outbox row", async () => {
    const transition: ClaimedTransition = {
      id: "42",
      deliveryId: "delivery-12",
      company: "Edilio",
      transitionKind: "release.published",
      payload: { schemaVersion: 1, repository: "edilio/plugin" },
      attempts: 1,
    };
    const queue = new MemoryTransitionQueue(transition);
    const messages: unknown[] = [];
    const publisher: PaperclipPublisher = {
      async publish(message) {
        messages.push(message);
      },
    };

    await expect(processNextTransition(queue, publisher, "publisher-a")).resolves.toBe("published");
    expect(messages).toEqual([
      {
        idempotencyKey: "github:delivery-12:release.published",
        deliveryId: "delivery-12",
        company: "Edilio",
        transitionKind: "release.published",
        payload: transition.payload,
      },
    ]);
    expect(queue.publishedId).toBe("42");
  });

  it("schedules a bounded retry when Paperclip publication fails", async () => {
    const queue = new MemoryTransitionQueue({
      id: "43",
      deliveryId: "delivery-13",
      company: "// Navigaite",
      transitionKind: "workflow_run.completed",
      payload: { schemaVersion: 1, repository: "navigaite/app" },
      attempts: 1,
    });
    const publisher: PaperclipPublisher = {
      async publish() {
        throw new Error("must not escape into evidence");
      },
    };

    await expect(processNextTransition(queue, publisher, "publisher-a")).resolves.toBe("infrastructure_failed");
    expect(queue.failure).toEqual({
      id: "43",
      maxAttempts: 5,
      reasonCode: "paperclip_unavailable",
    });
  });

  it("dead-letters a permanent publisher scope rejection without reflection", async () => {
    const queue = new MemoryTransitionQueue({
      id: "44",
      deliveryId: "delivery-14",
      company: "Private",
      transitionKind: "pull_request.opened",
      payload: { schemaVersion: 1, repository: "maxbec/api" },
      attempts: 1,
    });
    const publisher: PaperclipPublisher = {
      async publish() {
        throw Object.assign(new Error("private detail"), { code: "authorization_scope_mismatch" });
      },
    };

    await expect(processNextTransition(queue, publisher, "publisher-a", 9)).resolves.toBe("failed");
    expect(queue.failure).toEqual({
      id: "44",
      maxAttempts: 1,
      reasonCode: "authorization_scope_mismatch",
    });
    expect(JSON.stringify(queue.failure)).not.toContain("private detail");
  });
});
