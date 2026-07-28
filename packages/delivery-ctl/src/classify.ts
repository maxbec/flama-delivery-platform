export interface InventoryRepository {
  readonly nameWithOwner: string;
  readonly disposition: "in_scope" | "platform" | "excluded_fork" | "excluded_archived" | "excluded_unknown_owner";
  readonly mutationAllowed: boolean;
  readonly defaultBranch: string;
  readonly stack: readonly string[];
  readonly providerIndicators: readonly string[];
}

export interface ClassificationInput {
  readonly repositories: readonly InventoryRepository[];
}

export type BranchProfile = "fast" | "major";
export type MajorReason = "integration_branch" | "monorepo" | "deployment_provider";

export interface RepositoryClassification {
  readonly nameWithOwner: string;
  readonly profile: BranchProfile;
  readonly reasons: readonly MajorReason[];
}

export interface ClassificationResult {
  readonly schemaVersion: 1;
  readonly total: number;
  readonly profiles: Readonly<Record<BranchProfile, number>>;
  readonly repositories: readonly RepositoryClassification[];
}

export function classifyInventory(input: ClassificationInput): ClassificationResult {
  const inconsistent = input.repositories.find(
    (repository) => repository.disposition === "in_scope" && !repository.mutationAllowed,
  );
  if (inconsistent !== undefined) {
    throw new Error(`inconsistent mutation policy for ${inconsistent.nameWithOwner}`);
  }

  const repositories = input.repositories
    .filter((repository) => repository.disposition === "in_scope" && repository.mutationAllowed)
    .map((repository): RepositoryClassification => {
      const reasons: MajorReason[] = [];
      if (repository.defaultBranch === "dev") reasons.push("integration_branch");
      if (repository.stack.includes("node-monorepo")) reasons.push("monorepo");
      if (repository.providerIndicators.length > 0) reasons.push("deployment_provider");
      return {
        nameWithOwner: repository.nameWithOwner,
        profile: reasons.length > 0 ? "major" : "fast",
        reasons,
      };
    })
    .sort((left, right) => left.nameWithOwner.localeCompare(right.nameWithOwner));

  return {
    schemaVersion: 1,
    total: repositories.length,
    profiles: {
      fast: repositories.filter(({ profile }) => profile === "fast").length,
      major: repositories.filter(({ profile }) => profile === "major").length,
    },
    repositories,
  };
}
