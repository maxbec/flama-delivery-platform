import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyPaperclipBinding,
  type PaperclipBindingInput,
  type PaperclipBindingsClient,
  PostgresRepositoryBindingStore,
} from "../../../packages/delivery-ctl/src/paperclip-bindings.js";
import { PostgresInbox } from "./postgres-inbox.js";
import { PostgresRepositoryScope } from "./repository-scope.js";

describe("PostgreSQL durable inbox and outbox", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let inbox: PostgresInbox;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:18.0-alpine").start();
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 4 });
    for (const migration of ["001_inbox_outbox.sql", "002_repository_bindings.sql", "003_binding_identity.sql"]) {
      const migrationPath = fileURLToPath(new URL(`../migrations/${migration}`, import.meta.url));
      await pool.query(await readFile(migrationPath, "utf8"));
    }
    const bindingIdentityMigration = fileURLToPath(new URL("../migrations/003_binding_identity.sql", import.meta.url));
    await pool.query(await readFile(bindingIdentityMigration, "utf8"));
    inbox = new PostgresInbox(pool);
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it("deduplicates delivery IDs and claims a pending item once", async () => {
    const envelope = {
      deliveryId: "delivery-postgres-1",
      eventName: "workflow_run",
      owner: "maxbec",
      repository: "maxbec/api",
      payload: { action: "completed" },
      receivedAt: new Date("2026-07-28T08:00:00.000Z"),
    } as const;

    await expect(inbox.enqueue(envelope)).resolves.toBe("accepted");
    await expect(inbox.enqueue(envelope)).resolves.toBe("duplicate");

    const [firstClaim, competingClaim] = await Promise.all([
      inbox.claimNext("worker-a"),
      inbox.claimNext("worker-b"),
    ]);
    const claims = [firstClaim, competingClaim].filter((claim) => claim !== undefined);

    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ deliveryId: envelope.deliveryId, attempts: 1 });
  });

  it("atomically completes inbox work and emits one deduplicated transition", async () => {
    await expect(
      inbox.completeWithTransition({
        deliveryId: "delivery-postgres-1",
        company: "Private",
        transitionKind: "workflow_run_completed",
        payload: { conclusion: "success" },
      }),
    ).resolves.toBeUndefined();

    await expect(
      inbox.completeWithTransition({
        deliveryId: "delivery-postgres-1",
        company: "Private",
        transitionKind: "workflow_run_completed",
        payload: { conclusion: "success" },
      }),
    ).resolves.toBeUndefined();

    const result = await pool.query<{ inbox_status: string; outbox_count: string }>(`
      SELECT i.status AS inbox_status, count(o.id)::text AS outbox_count
      FROM flama_delivery.webhook_inbox AS i
      LEFT JOIN flama_delivery.transition_outbox AS o USING (delivery_id)
      WHERE i.delivery_id = $1
      GROUP BY i.status
    `, ["delivery-postgres-1"]);
    expect(result.rows[0]).toEqual({ inbox_status: "completed", outbox_count: "1" });
  });

  it("claims and publishes an outbox transition exactly once", async () => {
    const [firstClaim, competingClaim] = await Promise.all([
      inbox.claimNextTransition("publisher-a"),
      inbox.claimNextTransition("publisher-b"),
    ]);
    const claims = [firstClaim, competingClaim].filter((claim) => claim !== undefined);

    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      deliveryId: "delivery-postgres-1",
      company: "Private",
      transitionKind: "workflow_run_completed",
      attempts: 1,
    });
    await inbox.markTransitionPublished(claims[0]!.id);
    await expect(inbox.claimNextTransition("publisher-c")).resolves.toBeUndefined();
  });

  it("bounds retries and moves terminal failures to the dead-letter queue", async () => {
    await inbox.enqueue({
      deliveryId: "delivery-postgres-2",
      eventName: "pull_request",
      owner: "edilio",
      repository: "edilio/site",
      payload: { action: "closed" },
      receivedAt: new Date("2026-07-28T08:01:00.000Z"),
    });
    await inbox.claimNext("worker-a");

    await expect(
      inbox.fail({
        deliveryId: "delivery-postgres-2",
        reasonCode: "paperclip_unavailable",
        maxAttempts: 1,
      }),
    ).resolves.toBe("dead_lettered");

    const result = await pool.query<{ status: string; dead_letters: string }>(`
      SELECT i.status, count(d.id)::text AS dead_letters
      FROM flama_delivery.webhook_inbox AS i
      LEFT JOIN flama_delivery.dead_letter AS d USING (delivery_id)
      WHERE i.delivery_id = $1
      GROUP BY i.status
    `, ["delivery-postgres-2"]);
    expect(result.rows[0]).toEqual({ status: "dead_lettered", dead_letters: "1" });
  });

  it("dead-letters a terminal outbox failure without exposing payload data", async () => {
    await inbox.enqueue({
      deliveryId: "delivery-postgres-3",
      eventName: "release",
      owner: "navigaite",
      repository: "navigaite/app",
      payload: { action: "published" },
      receivedAt: new Date("2026-07-28T08:02:00.000Z"),
    });
    await inbox.claimNext("worker-a");
    await inbox.completeWithTransition({
      deliveryId: "delivery-postgres-3",
      company: "// Navigaite",
      transitionKind: "release_published",
      payload: { releaseId: 42 },
    });
    const transition = await inbox.claimNextTransition("publisher-a");
    expect(transition).toBeDefined();

    await expect(
      inbox.failTransition({
        id: transition!.id,
        reasonCode: "paperclip_unavailable",
        maxAttempts: 1,
      }),
    ).resolves.toBe("dead_lettered");

    const result = await pool.query<{ status: string; dead_letters: string }>(`
      SELECT o.status, count(d.id)::text AS dead_letters
      FROM flama_delivery.transition_outbox AS o
      LEFT JOIN flama_delivery.dead_letter AS d ON d.outbox_id = o.id
      WHERE o.id = $1
      GROUP BY o.status
    `, [transition!.id]);
    expect(result.rows[0]).toEqual({ status: "dead_lettered", dead_letters: "1" });
  });

  it("reports readiness and recovers a stale inbox claim for replay", async () => {
    await expect(inbox.check()).resolves.toBeUndefined();
    await inbox.enqueue({
      deliveryId: "delivery-postgres-stale-inbox",
      eventName: "push",
      owner: "maxbec",
      repository: "maxbec/api",
      payload: { schemaVersion: 1 },
      receivedAt: new Date("2026-07-28T08:03:00.000Z"),
    });
    await inbox.claimNext("worker-stale");
    await pool.query(
      `UPDATE flama_delivery.webhook_inbox
       SET locked_at = CURRENT_TIMESTAMP - INTERVAL '10 minutes'
       WHERE delivery_id = $1`,
      ["delivery-postgres-stale-inbox"],
    );

    await expect(inbox.recoverStaleClaims(60, 5)).resolves.toEqual({
      inboxRetried: 1,
      inboxDeadLettered: 0,
      outboxRetried: 0,
      outboxDeadLettered: 0,
    });
    await expect(inbox.claimNext("worker-replay")).resolves.toMatchObject({
      deliveryId: "delivery-postgres-stale-inbox",
      attempts: 2,
    });
  });

  it("dead-letters exhausted stale claims without payload evidence", async () => {
    await pool.query(
      `UPDATE flama_delivery.webhook_inbox
       SET locked_at = CURRENT_TIMESTAMP - INTERVAL '10 minutes'
       WHERE delivery_id = $1`,
      ["delivery-postgres-stale-inbox"],
    );

    await expect(inbox.recoverStaleClaims(60, 2)).resolves.toEqual({
      inboxRetried: 0,
      inboxDeadLettered: 1,
      outboxRetried: 0,
      outboxDeadLettered: 0,
    });
    const result = await pool.query<{ reason_code: string; payload_column_count: string }>(`
      SELECT d.reason_code,
             count(*) FILTER (WHERE column_name = 'payload')::text AS payload_column_count
      FROM flama_delivery.dead_letter AS d
      CROSS JOIN information_schema.columns AS columns
      WHERE d.delivery_id = $1
        AND columns.table_schema = 'flama_delivery'
        AND columns.table_name = 'dead_letter'
      GROUP BY d.reason_code
    `, ["delivery-postgres-stale-inbox"]);
    expect(result.rows[0]).toEqual({
      reason_code: "stale_claim_exhausted",
      payload_column_count: "0",
    });
  });

  it("allows only active non-fork non-archived repository bindings", async () => {
    const scope = new PostgresRepositoryScope(pool);
    const digest = `sha256:${"d".repeat(64)}`;
    await pool.query(
      `INSERT INTO flama_delivery.repository_binding
        (repository_name, github_repository_id, owner_name, company, project_id, workspace_id, profile,
         default_branch, active, is_fork, is_archived, inventory_digest, verified_at, binding_digest)
       VALUES
        ('maxbec/api', 101, 'maxbec', 'Private', '20000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000003', 'fast', 'main', true, false, false, $1, CURRENT_TIMESTAMP, $2),
        ('maxbec/retired', 102, 'maxbec', 'Private', '40000000-0000-4000-8000-000000000004', '50000000-0000-4000-8000-000000000005', 'fast', 'main', false, false, true, $1, CURRENT_TIMESTAMP, $2)`,
      [digest, `sha256:${"e".repeat(64)}`],
    );

    await expect(scope.allows("maxbec", "maxbec/api")).resolves.toBe(true);
    await expect(scope.allows("maxbec", "maxbec/retired")).resolves.toBe(false);
    await expect(scope.allows("maxbec", "maxbec/unknown")).resolves.toBe(false);
  });

  it("creates, reads back, reuses, and safely refreshes an exact binding", async () => {
    const companyId = "60000000-0000-4000-8000-000000000006";
    const projectId = "70000000-0000-4000-8000-000000000007";
    const workspaceId = "80000000-0000-4000-8000-000000000008";
    const base: PaperclipBindingInput = {
      schemaVersion: 1,
      company: { id: companyId, name: "Private" },
      controller: "maxbec-delivery-controller",
      repository: {
        nameWithOwner: "maxbec/bound-repository",
        githubRepositoryId: 901,
        profile: "fast",
        defaultBranch: "main",
        isFork: false,
        isArchived: false,
        inventoryDigest: `sha256:${"a".repeat(64)}`,
        inventoryVerifiedAt: "2026-07-29T04:00:00.000Z",
      },
      project: { id: projectId },
      workspace: { id: workspaceId },
      mutationAllowed: true,
    };
    const client: PaperclipBindingsClient = {
      async getCompany() { return { id: companyId, name: "Private", status: "active" }; },
      async getProject() { return { id: projectId, companyId, status: "in_progress", archivedAt: null }; },
      async listProjectWorkspaces() {
        return [{
          id: workspaceId,
          companyId,
          projectId,
          sourceType: "git_repo",
          repoUrl: "https://github.com/maxbec/bound-repository.git",
          defaultRef: "main",
        }];
      },
    };
    const store = new PostgresRepositoryBindingStore({ DATABASE_URL: container.getConnectionUri() });
    const now = new Date("2026-07-29T04:30:00.000Z");
    try {
      await expect(applyPaperclipBinding(base, client, store, now)).resolves.toMatchObject({ disposition: "created" });
      await expect(applyPaperclipBinding(base, client, store, now)).resolves.toMatchObject({ disposition: "reused" });
      const refreshed = {
        ...base,
        repository: {
          ...base.repository,
          inventoryDigest: `sha256:${"b".repeat(64)}`,
          inventoryVerifiedAt: "2026-07-29T04:10:00.000Z",
        },
      } as const;
      await expect(applyPaperclipBinding(refreshed, client, store, now)).resolves.toMatchObject({
        disposition: "refreshed",
      });
    } finally {
      await store.close();
    }
  });
});
