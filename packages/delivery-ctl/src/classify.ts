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
  /**
   * Profiles the approved policy states directly, for the repositories whose
   * shape misleads the rules. `platzl-finder` and `subscription-manager` ship
   * Dockerfiles, which reads as a deployment provider and so as the two-branch
   * profile, but both are run single-branch.
   */
  readonly profileOverrides?: Readonly<Record<string, BranchProfile>>;
}

export type BranchProfile = "fast" | "major";
export type MajorReason = "integration_branch" | "monorepo" | "deployment_provider" | "explicit_override";

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

  const classifiable = new Set(
    input.repositories
      .filter((repository) => repository.disposition === "in_scope" && repository.mutationAllowed)
      .map(({ nameWithOwner }) => nameWithOwner),
  );
  for (const nameWithOwner of Object.keys(input.profileOverrides ?? {})) {
    if (!classifiable.has(nameWithOwner)) {
      throw new Error(`profile override for a repository outside the classified set: ${nameWithOwner}`);
    }
  }

  const repositories = input.repositories
    .filter((repository) => repository.disposition === "in_scope" && repository.mutationAllowed)
    .map((repository): RepositoryClassification => {
      const override = input.profileOverrides?.[repository.nameWithOwner];
      if (override !== undefined) {
        return {
          nameWithOwner: repository.nameWithOwner,
          profile: override,
          reasons: ["explicit_override"],
        };
      }
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
