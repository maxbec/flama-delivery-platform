import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildBridgeApp } from "./app.js";
import type { EnqueueWebhook, WebhookEnvelope } from "./inbox.js";

class MemoryInbox implements EnqueueWebhook {
  readonly deliveries: WebhookEnvelope[] = [];

  async enqueue(envelope: WebhookEnvelope): Promise<"accepted" | "duplicate"> {
    if (this.deliveries.some(({ deliveryId }) => deliveryId === envelope.deliveryId)) {
      return "duplicate";
    }
    this.deliveries.push(envelope);
    return "accepted";
  }
}

const apps: Array<ReturnType<typeof buildBridgeApp>> = [];
const ready = { async check(): Promise<void> {} };
const maxbecScope = { async allows(_owner: string, repository: string): Promise<boolean> { return repository === "maxbec/api"; } };

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe("bridge webhook intake", () => {
  const secret = "test-only-webhook-secret";
  const body = JSON.stringify({
    action: "completed",
    repository: { id: 101, full_name: "maxbec/api" },
    workflow_run: {
      id: 501,
      name: "Final Gate",
      status: "completed",
      conclusion: "success",
      head_sha: "a".repeat(40),
      html_url: "https://github.com/maxbec/api/actions/runs/501",
      private_context: "sensitive-value-that-must-not-be-persisted",
    },
  });

  it("authenticates, durably enqueues, and deduplicates a delivery", async () => {
    const inbox = new MemoryInbox();
    const app = buildBridgeApp({ webhookSecret: secret, allowedOwner: "maxbec", inbox, readiness: ready, repositoryScope: maxbecScope });
    apps.push(app);
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    const headers = {
      "content-type": "application/json",
      "x-github-delivery": "delivery-1",
      "x-github-event": "workflow_run",
      "x-hub-signature-256": signature,
    };

    const first = await app.inject({ method: "POST", url: "/webhooks/github", headers, body });
    const replay = await app.inject({ method: "POST", url: "/webhooks/github", headers, body });

    expect(first.statusCode).toBe(202);
    expect(first.json()).toEqual({ accepted: true, duplicate: false });
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toEqual({ accepted: true, duplicate: true });
    expect(inbox.deliveries).toHaveLength(1);
    expect(inbox.deliveries[0]).toMatchObject({
      deliveryId: "delivery-1",
      eventName: "workflow_run",
      repository: "maxbec/api",
      owner: "maxbec",
      payload: {
        schemaVersion: 1,
        eventName: "workflow_run",
        repository: "maxbec/api",
        workflowRun: { id: 501, name: "Final Gate", headSha: "a".repeat(40) },
      },
    });
    expect(JSON.stringify(inbox.deliveries)).not.toContain("sensitive-value");
  });

  it("rejects an invalid signature before persistence and never echoes it", async () => {
    const inbox = new MemoryInbox();
    const app = buildBridgeApp({ webhookSecret: secret, allowedOwner: "maxbec", inbox, readiness: ready, repositoryScope: maxbecScope });
    apps.push(app);
    const invalidSignature = `sha256=${"0".repeat(64)}`;

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-2",
        "x-github-event": "workflow_run",
        "x-hub-signature-256": invalidSignature,
      },
      body,
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain(invalidSignature);
    expect(inbox.deliveries).toHaveLength(0);
  });

  it("rejects a validly signed event for another owner", async () => {
    const inbox = new MemoryInbox();
    const app = buildBridgeApp({ webhookSecret: secret, allowedOwner: "navigaite", inbox, readiness: ready, repositoryScope: maxbecScope });
    apps.push(app);
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-3",
        "x-github-event": "workflow_run",
        "x-hub-signature-256": signature,
      },
      body,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "owner_scope_denied" });
    expect(inbox.deliveries).toHaveLength(0);
  });

  it("acknowledges unneeded event types without persisting their payloads", async () => {
    const inbox = new MemoryInbox();
    const app = buildBridgeApp({ webhookSecret: secret, allowedOwner: "maxbec", inbox, readiness: ready, repositoryScope: maxbecScope });
    apps.push(app);
    const ignoredBody = JSON.stringify({ action: "opened", issue: { body: "sensitive-value" } });
    const signature = `sha256=${createHmac("sha256", secret).update(ignoredBody).digest("hex")}`;

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-4",
        "x-github-event": "issues",
        "x-hub-signature-256": signature,
      },
      body: ignoredBody,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: false, ignored: true });
    expect(inbox.deliveries).toHaveLength(0);
  });

  it("reports database readiness without exposing failure details", async () => {
    const inbox = new MemoryInbox();
    const app = buildBridgeApp({
      webhookSecret: secret,
      allowedOwner: "maxbec",
      inbox,
      readiness: { async check() { throw new Error("private connection detail"); } },
      repositoryScope: maxbecScope,
    });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "unavailable" });
    expect(response.body).not.toContain("private connection detail");
  });

  it("rejects an unbound repository under the configured owner", async () => {
    const inbox = new MemoryInbox();
    const app = buildBridgeApp({ webhookSecret: secret, allowedOwner: "maxbec", inbox, readiness: ready, repositoryScope: maxbecScope });
    apps.push(app);
    const unboundBody = body.replaceAll("maxbec/api", "maxbec/unbound");
    const signature = `sha256=${createHmac("sha256", secret).update(unboundBody).digest("hex")}`;

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-5",
        "x-github-event": "workflow_run",
        "x-hub-signature-256": signature,
      },
      body: unboundBody,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "repository_scope_denied" });
    expect(inbox.deliveries).toHaveLength(0);
  });
});
