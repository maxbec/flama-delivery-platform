export type SecretDestination =
  | "github_actions_secret"
  | "github_dependabot_secret"
  | "github_environment_secret"
  | "provider_native_secret";

export interface DestinationSecret {
  readonly key: string;
  readonly destination: SecretDestination;
  readonly delivery: "infisical_secret_sync" | "approved_destination_exception";
  readonly rotationDays: number;
  readonly lastRotatedAt: string;
}

export interface SecretException {
  readonly key: string;
  readonly destination: SecretDestination;
  readonly reason: string;
  readonly owner: string;
  readonly scope: "repository" | "environment" | "provider";
  readonly rotationDays: number;
  readonly expiresAt: string;
  readonly reviewAfter: string;
  readonly status: "approved";
}

interface ClassifiedName {
  readonly name: string;
  readonly classification: "identifier" | "secret_value";
}

export interface SecretsAuditInput {
  readonly schemaVersion: 1;
  readonly repository: { readonly visibility: "private" | "public"; readonly isFork: boolean };
  readonly infisical: {
    readonly sourceOfTruth: boolean;
    readonly projectSlug: string;
    readonly environmentMappings: readonly {
      readonly environment: string;
      readonly paths: readonly string[];
    }[];
    readonly machineIdentity: {
      readonly method: "oidc" | "workload" | "client-secret";
      readonly hardcodedClaims: boolean;
      readonly shortLived: boolean;
      readonly sharedAcrossRepositories: boolean;
      readonly projectScoped: boolean;
      readonly environmentScoped: boolean;
      readonly pathScoped: boolean;
      readonly claims: {
        readonly issuerExact: boolean;
        readonly audienceExact: boolean;
        readonly repositoryExact: boolean;
        readonly workflowExact: boolean;
        readonly refOrEnvironmentExact: boolean;
      };
    };
  };
  readonly publicPullRequest: {
    readonly secrets: boolean;
    readonly idToken: boolean;
    readonly infisical: boolean;
    readonly trustedCacheWrite: boolean;
    readonly privateRunner: boolean;
    readonly productionNetwork: boolean;
    readonly pullRequestTarget: boolean;
  };
  readonly trustedJobs: {
    readonly broadSecretInheritance: boolean;
    readonly leastPrivilegePath: boolean;
    readonly buildProductionSecrets: boolean;
    readonly releaseProductionSecrets: boolean;
    readonly productionAfterApprovalOnly: boolean;
    readonly deployApprovalBound: boolean;
  };
  readonly secretSyncs: readonly {
    readonly destination: SecretDestination;
    readonly targetScope: "repository" | "environment" | "provider";
    readonly allRepositories: boolean;
    readonly keySelection: "explicit";
    readonly keySchema: "FLAMA_{{environment}}_{{secretKey}}" | "destination_native_exact_keys";
    readonly automaticRotation: boolean;
    readonly initialOverwritePolicy: "source_authoritative" | "destination_import_once";
    readonly connectionCredentialSource: "infisical";
  }[];
  readonly destinationSecrets: readonly DestinationSecret[];
  readonly exceptions: readonly SecretException[];
  readonly repositoryVariables: readonly ClassifiedName[];
  readonly generatedConfiguration: readonly ClassifiedName[];
  readonly paperclipPrompts: readonly ClassifiedName[];
}

export interface SecretFinding {
  readonly code: string;
  readonly location: string;
}

export interface SecretsAuditResult {
  readonly schemaVersion: 1;
  readonly status: "passed" | "failed";
  readonly findingCount: number;
  readonly findings: readonly SecretFinding[];
}

function dateValue(source: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(source)) return undefined;
  const value = Date.parse(`${source}T00:00:00.000Z`);
  return Number.isFinite(value) && new Date(value).toISOString().slice(0, 10) === source ? value : undefined;
}

function canonicalScopePath(path: string): boolean {
  return /^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/u.test(path) && !path.includes("//") && !path.includes("..");
}

function destinationKey(value: { readonly destination: SecretDestination; readonly key: string }): string {
  return `${value.destination}:${value.key}`;
}

export function auditSecrets(input: SecretsAuditInput, now: Date): SecretsAuditResult {
  const findings: SecretFinding[] = [];
  const add = (code: string, location: string): void => {
    findings.push({ code, location });
  };
  const nowValue = now.getTime();
  const today = Number.isFinite(nowValue) ? now.toISOString().slice(0, 10) : undefined;
  if (!Number.isFinite(nowValue)) add("audit_time_invalid", "audit");

  if (input.schemaVersion !== 1) add("audit_contract_invalid", "input");
  if (input.repository.isFork) add("fork_scope_denied", "repository");
  if (!input.infisical.sourceOfTruth) add("infisical_source_required", "infisical");
  if (!/^[a-z0-9][a-z0-9-]{0,119}$/u.test(input.infisical.projectSlug)) {
    add("infisical_project_mapping_invalid", "infisical");
  }
  const environments = new Set<string>();
  if (input.infisical.environmentMappings.length === 0) {
    add("infisical_environment_mapping_missing", "infisical");
  }
  for (const mapping of input.infisical.environmentMappings) {
    if (environments.has(mapping.environment)) add("infisical_environment_mapping_duplicate", "infisical");
    environments.add(mapping.environment);
    if (mapping.paths.length === 0 || mapping.paths.some((path) => !canonicalScopePath(path))) {
      add("infisical_path_mapping_invalid", "infisical");
    }
    if (new Set(mapping.paths).size !== mapping.paths.length) {
      add("infisical_path_mapping_duplicate", "infisical");
    }
  }
  const identity = input.infisical.machineIdentity;
  if (identity.method !== "oidc") add("oidc_required", "infisical.machineIdentity");
  if (!identity.hardcodedClaims || Object.values(identity.claims).some((exact) => !exact)) {
    add("oidc_claims_not_exact", "infisical.machineIdentity");
  }
  if (!identity.shortLived) add("short_lived_identity_required", "infisical.machineIdentity");
  if (identity.sharedAcrossRepositories) add("shared_machine_identity", "infisical.machineIdentity");
  if (!identity.projectScoped || !identity.environmentScoped || !identity.pathScoped) {
    add("machine_identity_scope_too_broad", "infisical.machineIdentity");
  }

  if (Object.values(input.publicPullRequest).some(Boolean)) {
    add("public_pr_trust_capability_exposed", "publicPullRequest");
  }
  if (input.trustedJobs.broadSecretInheritance) add("broad_secret_inheritance", "trustedJobs");
  if (!input.trustedJobs.leastPrivilegePath) add("trusted_job_scope_too_broad", "trustedJobs");
  if (input.trustedJobs.buildProductionSecrets) add("build_production_secrets_exposed", "trustedJobs");
  if (input.trustedJobs.releaseProductionSecrets) add("release_production_secrets_exposed", "trustedJobs");
  if (!input.trustedJobs.productionAfterApprovalOnly || !input.trustedJobs.deployApprovalBound) {
    add("production_approval_boundary_missing", "trustedJobs");
  }

  const syncDestinations = new Set<SecretDestination>();
  for (const sync of input.secretSyncs) {
    syncDestinations.add(sync.destination);
    if (sync.allRepositories) add("secret_sync_scope_too_broad", "secretSyncs");
    if (sync.keySelection !== "explicit") add("secret_sync_key_selection_invalid", "secretSyncs");
    if (![
      "FLAMA_{{environment}}_{{secretKey}}",
      "destination_native_exact_keys",
    ].includes(sync.keySchema)) add("secret_sync_key_schema_invalid", "secretSyncs");
    if (!sync.automaticRotation) add("secret_sync_rotation_not_automatic", "secretSyncs");
    if (!sync.initialOverwritePolicy) add("secret_sync_overwrite_unspecified", "secretSyncs");
    if (sync.connectionCredentialSource !== "infisical") {
      add("secret_sync_connection_outside_infisical", "secretSyncs");
    }
  }

  const exceptionByKey = new Map<string, SecretException>();
  for (const exception of input.exceptions) {
    const key = destinationKey(exception);
    if (exceptionByKey.has(key)) add("duplicate_destination_exception", "exceptions");
    else exceptionByKey.set(key, exception);
    const expiresAt = dateValue(exception.expiresAt);
    const reviewAfter = dateValue(exception.reviewAfter);
    if (expiresAt === undefined || reviewAfter === undefined || reviewAfter > expiresAt) {
      add("destination_exception_dates_invalid", "exceptions");
      continue;
    }
    if (/\bconvenien(?:ce|t)\b/iu.test(exception.reason)) add("destination_exception_reason_invalid", "exceptions");
    if (today !== undefined && exception.expiresAt < today) add("destination_exception_expired", "exceptions");
    if (today !== undefined && exception.reviewAfter <= today) add("destination_exception_review_due", "exceptions");
  }

  const destinationKeys = new Set<string>();
  for (const secret of input.destinationSecrets) {
    const key = destinationKey(secret);
    if (destinationKeys.has(key)) add("duplicate_destination_secret", "destinationSecrets");
    destinationKeys.add(key);
    const exception = exceptionByKey.get(key);
    if (secret.delivery === "infisical_secret_sync") {
      if (!syncDestinations.has(secret.destination)) add("secret_sync_mapping_missing", "destinationSecrets");
      if (exception !== undefined) add("destination_delivery_ambiguous", "destinationSecrets");
    } else if (exception === undefined) {
      add("destination_exception_missing", "destinationSecrets");
    } else if (exception.rotationDays !== secret.rotationDays) {
      add("destination_rotation_policy_mismatch", "destinationSecrets");
    }
    const lastRotatedAt = dateValue(secret.lastRotatedAt);
    if (lastRotatedAt === undefined || !Number.isSafeInteger(secret.rotationDays) || secret.rotationDays < 1) {
      add("destination_rotation_metadata_invalid", "destinationSecrets");
    } else if (Number.isFinite(nowValue) && lastRotatedAt > nowValue) {
      add("destination_rotation_in_future", "destinationSecrets");
    } else if (Number.isFinite(nowValue) && lastRotatedAt + secret.rotationDays * 86_400_000 <= nowValue) {
      add("destination_rotation_due", "destinationSecrets");
    }
  }
  for (const key of exceptionByKey.keys()) {
    if (!destinationKeys.has(key)) add("orphaned_destination_exception", "exceptions");
  }

  const classifiedLocations = [
    ["repositoryVariables", input.repositoryVariables],
    ["generatedConfiguration", input.generatedConfiguration],
    ["paperclipPrompts", input.paperclipPrompts],
  ] as const;
  for (const [location, entries] of classifiedLocations) {
    if (entries.some(({ classification }) => classification === "secret_value")) {
      add("secret_value_in_untrusted_metadata", location);
    }
  }

  findings.sort((left, right) =>
    left.code === right.code
      ? left.location.localeCompare(right.location)
      : left.code.localeCompare(right.code),
  );
  return {
    schemaVersion: 1,
    status: findings.length === 0 ? "passed" : "failed",
    findingCount: findings.length,
    findings,
  };
}
