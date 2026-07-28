import { describe, expect, it } from "vitest";
import { BridgeConfigError, parseBridgeConfig } from "./config.js";

const validEnvironment = {
  DATABASE_URL: ["postgresql://bridge", ":example-database-password@", "db.internal:5432/flama"].join(""),
  FLAMA_BRIDGE_HOST: "127.0.0.1",
  FLAMA_BRIDGE_PORT: "3100",
  FLAMA_GITHUB_OWNER: "maxbec",
  FLAMA_STALE_CLAIM_SECONDS: "300",
  FLAMA_WORKER_ID: "bridge-worker-1",
  FLAMA_WORKER_MAX_ATTEMPTS: "5",
  FLAMA_WORKER_POLL_MILLISECONDS: "1000",
  GITHUB_WEBHOOK_SECRET: "example-webhook-secret-with-32-characters",
} as const;

describe("bridge configuration", () => {
  it("parses bounded runtime settings while keeping credentials non-serializable", () => {
    const config = parseBridgeConfig(validEnvironment);

    expect(config).toMatchObject({
      allowedOwner: "maxbec",
      host: "127.0.0.1",
      port: 3100,
      workerId: "bridge-worker-1",
      pollMilliseconds: 1000,
      staleClaimSeconds: 300,
      maxAttempts: 5,
    });
    const serialized = JSON.stringify(config);
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain("example-database-password");
    expect(serialized).not.toContain("example-webhook-secret");
  });

  it("returns stable error codes without reflecting rejected values", () => {
    const rejectedValue = "credential-that-must-not-be-reflected";
    let caught: unknown;
    try {
      parseBridgeConfig({ ...validEnvironment, DATABASE_URL: rejectedValue });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BridgeConfigError);
    expect(caught).toMatchObject({ code: "invalid_database_url", message: "bridge configuration rejected" });
    expect(JSON.stringify(caught)).not.toContain(rejectedValue);
  });

  it("defaults to loopback and rejects unsafe numeric bounds", () => {
    const config = parseBridgeConfig({
      ...validEnvironment,
      FLAMA_BRIDGE_HOST: undefined,
      FLAMA_BRIDGE_PORT: undefined,
    });
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(3000);

    expect(() => parseBridgeConfig({ ...validEnvironment, FLAMA_WORKER_MAX_ATTEMPTS: "100" }))
      .toThrowError(expect.objectContaining({ code: "invalid_worker_max_attempts" }));
  });
});
