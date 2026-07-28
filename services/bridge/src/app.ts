import Fastify, { type FastifyInstance } from "fastify";
import type { EnqueueWebhook, WebhookEnvelope } from "./inbox.js";
import { githubOwner, sanitizeGitHubWebhook } from "./github-event.js";
import type { RepositoryScope } from "./repository-scope.js";
import { verifyGitHubSignature } from "./signature.js";

export interface BridgeReadiness {
  check(): Promise<void>;
}

interface BridgeAppOptions {
  readonly webhookSecret: string;
  readonly allowedOwner: "maxbec" | "navigaite" | "edilio";
  readonly inbox: EnqueueWebhook;
  readonly readiness: BridgeReadiness;
  readonly repositoryScope: RepositoryScope;
}

function oneHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? undefined : value;
}

export function buildBridgeApp(options: BridgeAppOptions): FastifyInstance {
  const app = Fastify({
    logger: false,
    bodyLimit: 1_048_576,
  });

  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  app.get("/health", async () => ({ status: "ok" }));
  app.get("/ready", async (_request, reply) => {
    try {
      await options.readiness.check();
      return reply.code(200).send({ status: "ready" });
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });

  app.post("/webhooks/github", async (request, reply) => {
    const rawBody = request.body;
    if (!Buffer.isBuffer(rawBody)) {
      return reply.code(400).send({ error: "invalid_body" });
    }

    const signature = oneHeader(request.headers["x-hub-signature-256"]);
    if (!verifyGitHubSignature(rawBody, signature, options.webhookSecret)) {
      return reply.code(401).send({ error: "invalid_signature" });
    }

    const deliveryId = oneHeader(request.headers["x-github-delivery"]);
    const eventName = oneHeader(request.headers["x-github-event"]);
    if (
      deliveryId === undefined || eventName === undefined ||
      !/^[A-Za-z0-9._:-]{1,128}$/u.test(deliveryId) || !/^[a-z_]{1,64}$/u.test(eventName)
    ) {
      return reply.code(400).send({ error: "missing_delivery_headers" });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return reply.code(400).send({ error: "invalid_json" });
    }
    const sanitized = sanitizeGitHubWebhook(eventName, parsed);
    if (sanitized.status === "ignored") {
      return reply.code(202).send({ accepted: false, ignored: true });
    }
    if (sanitized.status === "invalid") {
      return reply.code(400).send({ error: "invalid_payload" });
    }

    const owner = githubOwner(sanitized.event.repository);
    if (owner === undefined) {
      return reply.code(400).send({ error: "invalid_repository" });
    }
    if (owner !== options.allowedOwner) {
      return reply.code(403).send({ error: "owner_scope_denied" });
    }
    try {
      if (!(await options.repositoryScope.allows(owner, sanitized.event.repository))) {
        return reply.code(403).send({ error: "repository_scope_denied" });
      }
    } catch {
      return reply.code(503).send({ error: "scope_unavailable" });
    }

    const envelope: WebhookEnvelope = {
      deliveryId,
      eventName,
      owner,
      repository: sanitized.event.repository,
      payload: sanitized.event,
      receivedAt: new Date(),
    };

    try {
      const result = await options.inbox.enqueue(envelope);
      return reply.code(202).send({ accepted: true, duplicate: result === "duplicate" });
    } catch {
      return reply.code(503).send({ error: "persistence_unavailable" });
    }
  });

  return app;
}
