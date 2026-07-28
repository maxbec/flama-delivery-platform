import { describe, expect, it } from "vitest";
import { auditSecrets } from "./secrets-audit.js";

describe("secrets audit", () => {
  const compliant = {
    repository: { visibility: "public" as const, isFork: false },
    infisical: {
      sourceOfTruth: true,
      projectSlug: "api",
      paths: ["/development", "/production"],
      machineIdentity: { method: "oidc" as const, hardcodedClaims: true },
    },
    publicPullRequest: {
      secrets: false,
      idToken: false,
      infisical: false,
      trustedCacheWrite: false,
      privateRunner: false,
    },
    destinationSecrets: [],
    exceptions: [],
    repositoryVariables: [{ name: "INFISICAL_PROJECT_SLUG", classification: "identifier" as const }],
  };

  it("passes an Infisical-first, OIDC-scoped configuration", () => {
    expect(auditSecrets(compliant, new Date("2026-07-28T00:00:00Z"))).toEqual({
      schemaVersion: 1,
      status: "passed",
      findingCount: 0,
      findings: [],
    });
  });

  it("fails closed using redacted finding codes", () => {
    const result = auditSecrets(
      {
        ...compliant,
        infisical: {
          ...compliant.infisical,
          machineIdentity: { method: "client-secret" as const, hardcodedClaims: false },
        },
        publicPullRequest: { ...compliant.publicPullRequest, idToken: true, secrets: true },
        destinationSecrets: [{ key: "DEPLOY_TOKEN", destination: "github_environment_secret" }],
        repositoryVariables: [{ name: "DATABASE_PASSWORD", classification: "secret_value" as const }],
      },
      new Date("2026-07-28T00:00:00Z"),
    );

    expect(result.status).toBe("failed");
    expect(result.findings).toEqual([
      { code: "destination_exception_missing", location: "destinationSecrets" },
      { code: "oidc_claims_not_hardcoded", location: "infisical.machineIdentity" },
      { code: "oidc_required", location: "infisical.machineIdentity" },
      { code: "public_pr_identity_exposed", location: "publicPullRequest" },
      { code: "public_pr_secrets_exposed", location: "publicPullRequest" },
      { code: "secret_in_repository_variable", location: "repositoryVariables" },
    ]);
    expect(JSON.stringify(result)).not.toContain("DEPLOY_TOKEN");
    expect(JSON.stringify(result)).not.toContain("DATABASE_PASSWORD");
  });
});
