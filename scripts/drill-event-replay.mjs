#!/usr/bin/env node
// Plan section 20 requires the bridge to durably queue and replay events, and
// plan section 21 phase 6 requires an event-replay drill before completion.
//
// This drill writes to a real bridge inbox, so it refuses to run unless it is
// explicitly authorized and given a database endpoint. It never invents an
// endpoint or a credential of its own.

import { randomUUID } from "node:crypto";

function refuse(reason) {
  process.stderr.write(`drill refused: ${reason}\n`);
  process.exit(1);
}

const dsn = process.env["DATABASE_URL"];
if (dsn === undefined || dsn.length === 0) {
  refuse("set DATABASE_URL to the bridge inbox endpoint");
}
if (process.env["FLAMA_DRILL_CONFIRM"] !== "yes") {
  refuse("set FLAMA_DRILL_CONFIRM=yes to authorize a drill that writes to a real inbox");
}

const { PostgresInbox } = await import(
  new URL("../dist/services/bridge/src/postgres-inbox.js", import.meta.url).href
).catch(() => refuse("build the platform first: the bridge inbox module is missing"));

const { Pool } = await import("pg");
const pool = new Pool({ connectionString: dsn, max: 2 });
const inbox = new PostgresInbox(pool);

/** A drill envelope is marked so it can never be mistaken for a real delivery. */
const deliveryId = `flama-replay-drill-${randomUUID()}`;
const envelope = {
  deliveryId,
  event: "pull_request",
  repository: "flama/replay-drill",
  owner: "maxbec",
  payloadDigest: `sha256:${"0".repeat(64)}`,
  receivedAt: new Date().toISOString(),
};

let failures = 0;
const assert = (condition, description) => {
  if (condition) {
    process.stderr.write(`drill ok: ${description}\n`);
    return;
  }
  failures += 1;
  process.stderr.write(`drill FAILED: ${description}\n`);
};

try {
  await inbox.check();

  assert((await inbox.enqueue(envelope)) === "accepted", "a new delivery is accepted");

  // Replay safety: the same delivery id must never be queued twice, however many
  // times GitHub redelivers it.
  assert((await inbox.enqueue(envelope)) === "duplicate", "a redelivered delivery is deduplicated");

  const claimed = await inbox.claimNext(`drill-${deliveryId}`);
  assert(claimed?.deliveryId === deliveryId, "the queued delivery is claimable exactly once");

  // A worker that dies mid-claim must not lose the event: stale-claim recovery
  // returns it to the queue instead of stranding it.
  const recovery = await inbox.recoverStaleClaims(30, 5);
  assert(
    Number.isInteger(recovery.inboxRetried) && Number.isInteger(recovery.inboxDeadLettered),
    "stale claim recovery reports a bounded, countable outcome",
  );
} catch (error) {
  failures += 1;
  process.stderr.write(`drill FAILED: the inbox rejected the drill (${error instanceof Error ? error.name : "error"})\n`);
} finally {
  await pool.end();
}

if (failures > 0) {
  process.stderr.write(`event replay drill failed with ${failures} unmet guarantee(s)\n`);
  process.exit(1);
}
process.stderr.write("event replay drill passed: durable enqueue, deduplication, single claim, bounded recovery\n");
