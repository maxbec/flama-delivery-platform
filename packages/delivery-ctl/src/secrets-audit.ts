export type SecretDestination =
  | "github_actions_secret"
  | "github_dependabot_secret"
  | "github_environment_secret"
  | "provider_native_secret";

export interface DestinationSecret {
  readonly key: string;
  readonly destination: SecretDestination;
}

export interface SecretException extends DestinationSecret {
  readonly reason: string;
  readonly owner: string;
  readonly scope: "repository" | "environment" | "provider";
  readonly rotationDays: number;
  readonly expiresAt: string;
  readonly reviewAfter: string;
  readonly status: "approved";
}

export interface SecretsAuditInput {
  readonly repository: { readonly visibility: "private" | "public"; readonly isFork: boolean };
  readonly infisical: {
    readonly sourceOfTruth: boolean;
    readonly projectSlug: string;
    readonly paths: readonly string[];
    readonly machineIdentity: {
      readonly method: "oidc" | "workload" | "client-secret";
      readonly hardcodedClaims: boolean;
    };
  };
  readonly publicPullRequest: {
    readonly secrets: boolean;
    readonly idToken: boolean;
    readonly infisical: boolean;
    readonly trustedCacheWrite: boolean;
    readonly privateRunner: boolean;
  };
  readonly destinationSecrets: readonly DestinationSecret[];
  readonly exceptions: readonly SecretException[];
  readonly repositoryVariables: readonly {
    readonly name: string;
    readonly classification: "identifier" | "secret_value";
  }[];
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

export function auditSecrets(input: SecretsAuditInput, now: Date): SecretsAuditResult {
  const findings: SecretFinding[] = [];
  const add = (code: string, location: string): void => {
    findings.push({ code, location });
  };

  if (!input.infisical.sourceOfTruth) add("infisical_source_required", "infisical");
  if (input.infisical.projectSlug.length === 0 || input.infisical.paths.length === 0) {
    add("infisical_scope_missing", "infisical");
  }
  if (input.infisical.machineIdentity.method !== "oidc") {
    add("oidc_required", "infisical.machineIdentity");
  }
  if (!input.infisical.machineIdentity.hardcodedClaims) {
    add("oidc_claims_not_hardcoded", "infisical.machineIdentity");
  }

  if (input.publicPullRequest.secrets) add("public_pr_secrets_exposed", "publicPullRequest");
  if (input.publicPullRequest.idToken || input.publicPullRequest.infisical) {
    add("public_pr_identity_exposed", "publicPullRequest");
  }
  if (input.publicPullRequest.trustedCacheWrite) {
    add("public_pr_trusted_cache_write", "publicPullRequest");
  }
  if (input.publicPullRequest.privateRunner) add("public_pr_private_runner", "publicPullRequest");

  const today = now.toISOString().slice(0, 10);
  const exceptionKeys = new Set<string>();
  for (const exception of input.exceptions) {
    const key = `${exception.destination}:${exception.key}`;
    if (exceptionKeys.has(key)) add("duplicate_destination_exception", "exceptions");
    exceptionKeys.add(key);
    if (exception.expiresAt < today) add("destination_exception_expired", "exceptions");
    if (exception.reviewAfter <= today) add("destination_exception_review_due", "exceptions");
  }
  for (const secret of input.destinationSecrets) {
    if (!exceptionKeys.has(`${secret.destination}:${secret.key}`)) {
      add("destination_exception_missing", "destinationSecrets");
    }
  }
  if (input.repositoryVariables.some(({ classification }) => classification === "secret_value")) {
    add("secret_in_repository_variable", "repositoryVariables");
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
