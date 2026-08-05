import { describe, expect, it } from "vitest";
import { auditSecrets, type SecretsAuditInput } from "./secrets-audit.js";

describe("secrets audit", () => {
  const compliant: SecretsAuditInput = {
    schemaVersion: 1,
    repository: { visibility: "public", isFork: false },
    infisical: {
      sourceOfTruth: true,
      projectSlug: "example-project",
      environmentMappings: [
        { environment: "development", paths: ["/application/development"] },
        { environment: "production", paths: ["/application/production"] },
      ],
      machineIdentity: {
        method: "oidc",
        hardcodedClaims: true,
        shortLived: true,
        sharedAcrossRepositories: false,
        projectScoped: true,
        environmentScoped: true,
        pathScoped: true,
        claims: {
          issuerExact: true,
          audienceExact: true,
          repositoryExact: true,
          workflowExact: true,
          refOrEnvironmentExact: true,
        },
      },
    },
    publicPullRequest: {
      secrets: false,
      idToken: false,
      infisical: false,
      trustedCacheWrite: false,
      privateRunner: false,
      productionNetwork: false,
      pullRequestTarget: false,
    },
    trustedJobs: {
      broadSecretInheritance: false,
      leastPrivilegePath: true,
      buildProductionSecrets: false,
      releaseProductionSecrets: false,
      productionAfterApprovalOnly: true,
      deployApprovalBound: true,
    },
    secretSyncs: [{
      destination: "provider_native_secret",
      targetScope: "provider",
      allRepositories: false,
      keySelection: "explicit",
      keySchema: "destination_native_exact_keys",
      automaticRotation: true,
      initialOverwritePolicy: "source_authoritative",
      connectionCredentialSource: "infisical",
    }],
    destinationSecrets: [
      {
        key: "SYNCED_PROVIDER_TOKEN",
        destination: "provider_native_secret",
        delivery: "infisical_secret_sync",
        rotationDays: 30,
        lastRotatedAt: "2026-07-15",
      },
      {
        key: "DEPENDABOT_REGISTRY_TOKEN",
        destination: "github_dependabot_secret",
        delivery: "approved_destination_exception",
        rotationDays: 30,
        lastRotatedAt: "2026-07-15",
      },
    ],
    exceptions: [{
      key: "DEPENDABOT_REGISTRY_TOKEN",
      destination: "github_dependabot_secret",
      reason: "Runtime retrieval is unsupported by the dependency update service",
      owner: "security-owner",
      scope: "repository",
      rotationDays: 30,
      expiresAt: "2026-09-01",
      reviewAfter: "2026-08-15",
      status: "approved",
    }],
    repositoryVariables: [{ name: "INFISICAL_PROJECT_SLUG", classification: "identifier" }],
    generatedConfiguration: [{ name: "INFISICAL_IDENTITY_ID", classification: "identifier" }],
    paperclipPrompts: [{ name: "INFISICAL_PATH_REFERENCE", classification: "identifier" }],
  };

  it("passes an Infisical-first, exact OIDC and scoped-sync configuration", () => {
    expect(auditSecrets(compliant, new Date("2026-07-28T00:00:00Z"))).toEqual({
      schemaVersion: 1,
      status: "passed",
      findingCount: 0,
      findings: [],
    });
  });

  it("fails closed using redacted finding codes", () => {
    const privateNames = ["PRIVATE_DEPLOY_TOKEN", "DATABASE_PASSWORD", "PRIVATE_PROMPT_SECRET"];
    const result = auditSecrets(
      {
        ...compliant,
        infisical: {
          ...compliant.infisical,
          environmentMappings: [
            { environment: "production", paths: ["/application/../production"] },
            { environment: "production", paths: ["/application/production"] },
          ],
          machineIdentity: {
            method: "client-secret",
            hardcodedClaims: false,
            shortLived: false,
            sharedAcrossRepositories: true,
            projectScoped: false,
            environmentScoped: false,
            pathScoped: false,
            claims: {
              issuerExact: false,
              audienceExact: false,
              repositoryExact: false,
              workflowExact: false,
              refOrEnvironmentExact: false,
            },
          },
        },
        publicPullRequest: { ...compliant.publicPullRequest, idToken: true, secrets: true },
        trustedJobs: {
          ...compliant.trustedJobs,
          broadSecretInheritance: true,
          leastPrivilegePath: false,
          buildProductionSecrets: true,
          productionAfterApprovalOnly: false,
        },
        destinationSecrets: [{
          key: privateNames[0] ?? "UNREACHABLE",
          destination: "github_environment_secret",
          delivery: "approved_destination_exception",
          rotationDays: 30,
          lastRotatedAt: "2026-01-01",
        }],
        exceptions: [],
        repositoryVariables: [{ name: privateNames[1] ?? "UNREACHABLE", classification: "secret_value" }],
        generatedConfiguration: [],
        paperclipPrompts: [{ name: privateNames[2] ?? "UNREACHABLE", classification: "secret_value" }],
      },
      new Date("2026-07-28T00:00:00Z"),
    );

    expect(result.status).toBe("failed");
    expect(result.findings).toEqual(expect.arrayContaining([
      { code: "broad_secret_inheritance", location: "trustedJobs" },
      { code: "build_production_secrets_exposed", location: "trustedJobs" },
      { code: "destination_exception_missing", location: "destinationSecrets" },
      { code: "destination_rotation_due", location: "destinationSecrets" },
      { code: "infisical_environment_mapping_duplicate", location: "infisical" },
      { code: "infisical_path_mapping_invalid", location: "infisical" },
      { code: "machine_identity_scope_too_broad", location: "infisical.machineIdentity" },
      { code: "oidc_claims_not_exact", location: "infisical.machineIdentity" },
      { code: "oidc_required", location: "infisical.machineIdentity" },
      { code: "production_approval_boundary_missing", location: "trustedJobs" },
      { code: "public_pr_trust_capability_exposed", location: "publicPullRequest" },
      { code: "secret_value_in_untrusted_metadata", location: "paperclipPrompts" },
      { code: "secret_value_in_untrusted_metadata", location: "repositoryVariables" },
      { code: "shared_machine_identity", location: "infisical.machineIdentity" },
      { code: "short_lived_identity_required", location: "infisical.machineIdentity" },
      { code: "trusted_job_scope_too_broad", location: "trustedJobs" },
    ]));
    for (const privateName of privateNames) expect(JSON.stringify(result)).not.toContain(privateName);
  });

  it("rejects ambiguous sync delivery and orphaned exceptions without naming either secret", () => {
    const result = auditSecrets({
      ...compliant,
      destinationSecrets: [{
        key: "SYNCED_PRIVATE_VALUE",
        destination: "provider_native_secret",
        delivery: "infisical_secret_sync",
        rotationDays: 30,
        lastRotatedAt: "2026-07-15",
      }],
      exceptions: [
        {
          key: "SYNCED_PRIVATE_VALUE",
          destination: "provider_native_secret",
          reason: "This intentionally exercises an invalid duplicate delivery path",
          owner: "security-owner",
          scope: "provider",
          rotationDays: 30,
          expiresAt: "2026-09-01",
          reviewAfter: "2026-08-15",
          status: "approved",
        },
        {
          key: "ORPHANED_PRIVATE_VALUE",
          destination: "github_actions_secret",
          reason: "This intentionally exercises an orphaned exception record",
          owner: "security-owner",
          scope: "repository",
          rotationDays: 30,
          expiresAt: "2026-09-01",
          reviewAfter: "2026-08-15",
          status: "approved",
        },
      ],
    }, new Date("2026-07-28T00:00:00Z"));

    expect(result.findings).toEqual(expect.arrayContaining([
      { code: "destination_delivery_ambiguous", location: "destinationSecrets" },
      { code: "orphaned_destination_exception", location: "exceptions" },
    ]));
    expect(JSON.stringify(result)).not.toContain("SYNCED_PRIVATE_VALUE");
    expect(JSON.stringify(result)).not.toContain("ORPHANED_PRIVATE_VALUE");
  });
});
