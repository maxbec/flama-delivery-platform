import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  GitHubAppTokenError,
  hasGitHubAppCredentials,
  mintInstallationToken,
  type MintInstallationTokenInput,
} from "./github-app-token.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const environment = {
  FLAMA_GITHUB_APP_ID_MAXBEC: "150130477",
  FLAMA_GITHUB_APP_PRIVATE_KEY_MAXBEC: privateKey,
};

interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
  readonly authorization: string | null;
}

function stub(
  overrides: {
    readonly installation?: unknown;
    readonly token?: unknown;
    readonly installationStatus?: number;
    readonly tokenStatus?: number;
  } = {},
  recorded: Recorded[] = [],
): typeof fetch {
  return (async (input, init) => {
    const url = String(input);
    recorded.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    const json = (value: unknown, status: number) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "Content-Type": "application/json" },
      });

    if (url.endsWith("/installation")) {
      return json(overrides.installation ?? { id: 150130477 }, overrides.installationStatus ?? 200);
    }
    return json(
      overrides.token ?? {
        token: "ghs_test-value-not-a-real-token",
        expires_at: "2026-08-10T08:15:00Z",
        permissions: { checks: "write" },
      },
      overrides.tokenStatus ?? 201,
    );
  }) as typeof fetch;
}

function run(overrides: Partial<MintInstallationTokenInput> = {}, fetchImplementation = stub()) {
  return mintInstallationToken({
    repository: "maxbec/crewdo",
    environment,
    fetchImplementation,
    now: () => new Date("2026-08-10T08:00:00.000Z"),
    ...overrides,
  });
}

describe("github app installation token", () => {
  it("resolves the hyphenated Edilio owner to its closed credential suffix", () => {
    expect(hasGitHubAppCredentials({
      FLAMA_GITHUB_APP_ID_EDILIO: "150130478",
      FLAMA_GITHUB_APP_PRIVATE_KEY_EDILIO: privateKey,
    }, "edilio-app")).toBe(true);
    expect(hasGitHubAppCredentials({
      FLAMA_GITHUB_APP_ID_EDILIO_APP: "150130478",
      FLAMA_GITHUB_APP_PRIVATE_KEY_EDILIO_APP: privateKey,
    }, "edilio-app")).toBe(false);
  });

  it("scopes the token to the single repository and to checks write", async () => {
    const recorded: Recorded[] = [];
    const token = await run({}, stub({}, recorded));

    expect(token.reveal()).toBe("ghs_test-value-not-a-real-token");
    expect(token.expiresAt).toBe("2026-08-10T08:15:00Z");

    const mint = recorded.find(({ method }) => method === "POST");
    expect(mint?.body).toEqual({ repositories: ["crewdo"], permissions: { checks: "write" } });
  });

  /*
   * The token is the one value in this flow that must never reach a log, a
   * summary or an artifact, so redaction is asserted rather than assumed.
   */
  it("redacts the token when serialised, stringified or inspected", async () => {
    const token = await run();

    expect(JSON.stringify({ token })).toBe('{"token":"[REDACTED]"}');
    expect(`${token}`).not.toContain("ghs_");
    expect((await import("node:util")).inspect(token)).not.toContain("ghs_");
  });

  it("fails closed when GitHub grants a narrower permission than requested", async () => {
    await expect(
      run({}, stub({ token: { token: "ghs_test-narrow", expires_at: "2026-08-10T08:15:00Z", permissions: { checks: "read" } } })),
    ).rejects.toMatchObject({ code: "app_permission_insufficient" });
  });

  it("reports a repository outside the installation as not found rather than retrying", async () => {
    await expect(run({}, stub({ installationStatus: 404 }))).rejects.toMatchObject({
      code: "app_installation_not_found",
    });
  });

  it("refuses an owner it holds no credential for", async () => {
    await expect(run({ repository: "someone-else/repo" })).rejects.toMatchObject({
      code: "app_credentials_unavailable",
    });
  });

  it("refuses a repository that is not exactly owner/name", async () => {
    await expect(run({ repository: "maxbec/crewdo/extra" })).rejects.toMatchObject({
      code: "app_repository_out_of_scope",
    });
  });

  /*
   * Assembled rather than written out: a contiguous PEM header in this file is
   * indistinguishable from a real leaked key to the repository audit, and that
   * scanner should stay noisy.
   */
  it("refuses a malformed private key without surfacing crypto internals", async () => {
    const header = ["-----BEGIN", "PRIVATE", "KEY-----"].join(" ");
    await expect(
      run({
        environment: {
          ...environment,
          FLAMA_GITHUB_APP_PRIVATE_KEY_MAXBEC: `${header}\nnonsense\n`,
        },
      }),
    ).rejects.toBeInstanceOf(GitHubAppTokenError);
  });

  it("does not send the App JWT to the token endpoint as a bearer of the installation", async () => {
    const recorded: Recorded[] = [];
    await run({}, stub({}, recorded));

    // Both calls authenticate as the App; the minted token must never be reused
    // as the credential that minted it.
    expect(recorded).toHaveLength(2);
    for (const call of recorded) {
      expect(call.authorization?.startsWith("Bearer eyJ")).toBe(true);
    }
  });
});
