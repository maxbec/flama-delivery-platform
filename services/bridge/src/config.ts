import { inspect } from "node:util";
import type { GitHubOwner } from "./github-event.js";

type Environment = Readonly<Record<string, string | undefined>>;

export class SecretValue {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return "[REDACTED]";
  }

  toString(): string {
    return "[REDACTED]";
  }

  [inspect.custom](): string {
    return "SecretValue([REDACTED])";
  }
}

export type BridgeConfigErrorCode =
  | "invalid_database_url"
  | "invalid_host"
  | "invalid_owner"
  | "invalid_port"
  | "invalid_stale_claim_seconds"
  | "invalid_webhook_secret"
  | "invalid_worker_id"
  | "invalid_worker_max_attempts"
  | "invalid_worker_poll_milliseconds";

export class BridgeConfigError extends Error {
  constructor(readonly code: BridgeConfigErrorCode) {
    super("bridge configuration rejected");
    this.name = "BridgeConfigError";
  }

  toJSON(): Readonly<{ code: BridgeConfigErrorCode; message: string }> {
    return { code: this.code, message: this.message };
  }
}

export interface BridgeConfig {
  readonly databaseUrl: SecretValue;
  readonly webhookSecret: SecretValue;
  readonly allowedOwner: GitHubOwner;
  readonly host: "127.0.0.1" | "0.0.0.0" | "::";
  readonly port: number;
  readonly workerId: string;
  readonly pollMilliseconds: number;
  readonly staleClaimSeconds: number;
  readonly maxAttempts: number;
}

function boundedInteger(
  value: string | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
  code: BridgeConfigErrorCode,
): number {
  const source = value ?? String(defaultValue);
  if (!/^[0-9]+$/u.test(source)) throw new BridgeConfigError(code);
  const parsed = Number(source);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new BridgeConfigError(code);
  }
  return parsed;
}

function parseDatabaseUrl(value: string | undefined): SecretValue {
  if (value === undefined || value.length > 4_096 || /[\r\n]/u.test(value)) {
    throw new BridgeConfigError("invalid_database_url");
  }
  try {
    const url = new URL(value);
    if (!(["postgres:", "postgresql:"] as const).includes(url.protocol as "postgres:" | "postgresql:") || url.hostname.length === 0) {
      throw new BridgeConfigError("invalid_database_url");
    }
  } catch (error) {
    if (error instanceof BridgeConfigError) throw error;
    throw new BridgeConfigError("invalid_database_url");
  }
  return new SecretValue(value);
}

function parseWebhookSecret(value: string | undefined): SecretValue {
  if (value === undefined || value.length < 32 || value.length > 4_096 || /[\r\n]/u.test(value)) {
    throw new BridgeConfigError("invalid_webhook_secret");
  }
  return new SecretValue(value);
}

export function parseBridgeConfig(environment: Environment): BridgeConfig {
  const owner = environment["FLAMA_GITHUB_OWNER"];
  if (owner !== "maxbec" && owner !== "navigaite" && owner !== "edilio-app") {
    throw new BridgeConfigError("invalid_owner");
  }
  const host = environment["FLAMA_BRIDGE_HOST"] ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "0.0.0.0" && host !== "::") {
    throw new BridgeConfigError("invalid_host");
  }
  const workerId = environment["FLAMA_WORKER_ID"];
  if (workerId === undefined || !/^[A-Za-z0-9._:-]{1,128}$/u.test(workerId)) {
    throw new BridgeConfigError("invalid_worker_id");
  }
  return {
    databaseUrl: parseDatabaseUrl(environment["DATABASE_URL"]),
    webhookSecret: parseWebhookSecret(environment["GITHUB_WEBHOOK_SECRET"]),
    allowedOwner: owner,
    host,
    port: boundedInteger(environment["FLAMA_BRIDGE_PORT"], 3_000, 1_024, 65_535, "invalid_port"),
    workerId,
    pollMilliseconds: boundedInteger(
      environment["FLAMA_WORKER_POLL_MILLISECONDS"],
      1_000,
      100,
      60_000,
      "invalid_worker_poll_milliseconds",
    ),
    staleClaimSeconds: boundedInteger(
      environment["FLAMA_STALE_CLAIM_SECONDS"],
      300,
      30,
      3_600,
      "invalid_stale_claim_seconds",
    ),
    maxAttempts: boundedInteger(
      environment["FLAMA_WORKER_MAX_ATTEMPTS"],
      5,
      1,
      20,
      "invalid_worker_max_attempts",
    ),
  };
}
