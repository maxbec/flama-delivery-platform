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

  it("accepts a private bind address so a tunnel connector on another host can reach it", () => {
    for (const host of ["192.168.1.204", "10.0.0.5", "172.16.0.1", "172.31.255.254", "::1"]) {
      expect(parseBridgeConfig({ ...validEnvironment, FLAMA_BRIDGE_HOST: host }).host).toBe(host);
    }
  });

  it("refuses a bind address that is not demonstrably private", () => {
    for (const host of [
      "8.8.8.8", // public
      "172.32.0.1", // just outside the private range
      "172.15.255.255",
      "192.169.1.1",
      "localhost", // a name resolves to something this process cannot check
      "bridge.internal.example",
      "192.168.01.204", // a leading zero is octal to some resolvers and decimal to others
      "192.168.1.204:3010",
      "999.1.1.1",
      "192.168.1.999", // a private prefix does not make the rest of the address valid
      "192.168.300.1",
      "192.168.1",
      "",
    ]) {
      expect(() => parseBridgeConfig({ ...validEnvironment, FLAMA_BRIDGE_HOST: host }))
        .toThrowError(expect.objectContaining({ code: "invalid_host" }));
    }
  });
});
