import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { buildBridgeApp } from "./app.js";
import { parseBridgeConfig } from "./config.js";
import {
  AuthorizedPaperclipPublisher,
  PaperclipPublicationError,
  PaperclipRestTransitionApi,
  PostgresTransitionAuthorizationStore,
} from "./paperclip-publisher.js";
import { PostgresInbox } from "./postgres-inbox.js";
import { processNextTransition, processNextWebhook } from "./processor.js";
import { PostgresRepositoryScope } from "./repository-scope.js";
import { runWorkerLoop, SystemWorkerWait } from "./worker-loop.js";

type Environment = Readonly<Record<string, string | undefined>>;
type CompanyName = "Private" | "// Navigaite" | "Edilio";

const companyByOwner = {
  maxbec: "Private",
  navigaite: "// Navigaite",
  edilio: "Edilio",
} as const satisfies Readonly<Record<string, CompanyName>>;

function publisherCompanyId(environment: Environment): string {
  const value = environment["PAPERCLIP_COMPANY_ID"];
  if (
    value === undefined ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  ) throw new PaperclipPublicationError("paperclip_identity_unavailable");
  return value;
}

export async function runBridgeRuntime(
  environment: Environment,
  signal: AbortSignal,
): Promise<"stopped" | "paused"> {
  const config = parseBridgeConfig(environment);
  const companyId = publisherCompanyId(environment);
  const api = new PaperclipRestTransitionApi(environment);
  const pool = new Pool({ connectionString: config.databaseUrl.reveal(), max: 8 });
  const inbox = new PostgresInbox(pool);
  const repositoryScope = new PostgresRepositoryScope(pool);
  const authorizations = new PostgresTransitionAuthorizationStore(pool);
  const publisher = new AuthorizedPaperclipPublisher(
    companyByOwner[config.allowedOwner],
    companyId,
    authorizations,
    api,
  );
  const app = buildBridgeApp({
    webhookSecret: config.webhookSecret.reveal(),
    allowedOwner: config.allowedOwner,
    inbox,
    readiness: inbox,
    repositoryScope,
  });
  const runtimeController = new AbortController();
  const stopFromParent = () => runtimeController.abort(signal.reason);
  signal.addEventListener("abort", stopFromParent, { once: true });
  if (signal.aborted) stopFromParent();
  const wait = new SystemWorkerWait();
  let paused = false;
  const pause = () => {
    paused = true;
    runtimeController.abort(new Error("bridge worker paused"));
  };

  try {
    if (runtimeController.signal.aborted) return "stopped";
    await inbox.recoverStaleClaims(config.staleClaimSeconds, config.maxAttempts);
    await app.listen({ host: config.host, port: config.port });
    await Promise.all([
      runWorkerLoop({
        signal: runtimeController.signal,
        pollIntervalMilliseconds: config.pollMilliseconds,
        runOnce: async () => processNextWebhook(inbox, repositoryScope, config.workerId),
        wait,
        onPause: pause,
      }),
      runWorkerLoop({
        signal: runtimeController.signal,
        pollIntervalMilliseconds: config.pollMilliseconds,
        runOnce: async () => processNextTransition(inbox, publisher, config.workerId, config.maxAttempts),
        wait,
        onPause: pause,
      }),
      runWorkerLoop({
        signal: runtimeController.signal,
        pollIntervalMilliseconds: 30_000,
        runOnce: async () => {
          await inbox.recoverStaleClaims(config.staleClaimSeconds, config.maxAttempts);
          return "idle";
        },
        wait,
        onPause: pause,
      }),
    ]);
    return paused ? "paused" : "stopped";
  } finally {
    signal.removeEventListener("abort", stopFromParent);
    runtimeController.abort();
    try {
      await app.close();
    } finally {
      await pool.end();
    }
  }
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const outcome = await runBridgeRuntime(process.env, controller.signal);
    if (outcome === "paused") {
      process.stderr.write('{"status":"paused","reason":"repeated_infrastructure_failure"}\n');
      process.exitCode = 1;
    }
  } catch {
    process.stderr.write('{"status":"failed","reason":"bridge_runtime_failure"}\n');
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

const invokedPath = process.argv[1];
let invokedDirectly = false;
if (invokedPath !== undefined) {
  try {
    invokedDirectly = realpathSync(invokedPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    invokedDirectly = false;
  }
}
if (invokedDirectly) {
  await main();
}
