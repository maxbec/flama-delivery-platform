import { createHash } from "node:crypto";

interface Counts {
  readonly inScope: number;
  readonly private: number;
  readonly public: number;
  readonly forks: number;
  readonly archived: number;
}

interface Summary extends Counts {
  readonly total: number;
  readonly platform: number;
  readonly mutationAllowed: number;
  readonly mutationDenied: number;
}

interface InventoryRepository {
  readonly owner: string;
  readonly isFork: boolean;
  readonly isArchived: boolean;
  readonly isPrivate: boolean;
  readonly disposition: "in_scope" | "platform" | "excluded_fork" | "excluded_archived" | "excluded_unknown_owner";
  readonly mutationAllowed: boolean;
}

export interface InventoryAuditInput {
  readonly schemaVersion: 1;
  readonly observedAt: string;
  readonly source: { readonly mode: "live" | "fixture" };
  readonly policyVersion: number;
  readonly summary: Summary;
  readonly owners: Readonly<Record<string, { readonly expected: Counts; readonly observed: Counts }>>;
  readonly repositories: readonly InventoryRepository[];
}

export interface InventoryAuditResult {
  readonly schemaVersion: 1;
  readonly status: "passed";
  readonly observedAt: string;
  readonly sourceMode: "live" | "fixture";
  readonly policyVersion: number;
  readonly inventoryDigest: string;
  readonly summary: Summary;
  readonly owners: Readonly<Record<string, { readonly countsMatch: true; readonly observed: Counts }>>;
}

export class InventoryAuditError extends Error {
  constructor(readonly code: "inventory_count_mismatch" | "inventory_scope_violation") {
    super("inventory audit rejected");
    this.name = "InventoryAuditError";
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(
        ([key, nested]) => [key, stableValue(nested)],
      ),
    );
  }
  return value;
}

function countsFor(repositories: readonly InventoryRepository[]): Counts {
  return {
    inScope: repositories.filter(({ disposition }) => disposition === "in_scope").length,
    private: repositories.filter(({ disposition, isPrivate }) => disposition === "in_scope" && isPrivate).length,
    public: repositories.filter(({ disposition, isPrivate }) => disposition === "in_scope" && !isPrivate).length,
    forks: repositories.filter(({ isFork }) => isFork).length,
    archived: repositories.filter(({ isArchived }) => isArchived).length,
  };
}

function equalCounts(left: Counts, right: Counts): boolean {
  return left.inScope === right.inScope && left.private === right.private &&
    left.public === right.public && left.forks === right.forks && left.archived === right.archived;
}

export function auditInventory(input: InventoryAuditInput): InventoryAuditResult {
  if (
    input.repositories.some((repository) =>
      (repository.isFork || repository.isArchived) && repository.mutationAllowed,
    ) ||
    input.repositories.some((repository) =>
      repository.disposition === "in_scope" && !repository.mutationAllowed,
    )
  ) throw new InventoryAuditError("inventory_scope_violation");

  const recomputedCounts = countsFor(input.repositories);
  const recomputedSummary: Summary = {
    total: input.repositories.length,
    ...recomputedCounts,
    platform: input.repositories.filter(({ disposition }) => disposition === "platform").length,
    mutationAllowed: input.repositories.filter(({ mutationAllowed }) => mutationAllowed).length,
    mutationDenied: input.repositories.filter(({ mutationAllowed }) => !mutationAllowed).length,
  };
  if (JSON.stringify(stableValue(recomputedSummary)) !== JSON.stringify(stableValue(input.summary))) {
    throw new InventoryAuditError("inventory_count_mismatch");
  }

  const ownerResults: Record<string, { countsMatch: true; observed: Counts }> = {};
  for (const [owner, counts] of Object.entries(input.owners).sort(([left], [right]) => left.localeCompare(right))) {
    const observed = countsFor(input.repositories.filter((repository) => repository.owner === owner));
    if (!equalCounts(observed, counts.observed) || !equalCounts(counts.expected, counts.observed)) {
      throw new InventoryAuditError("inventory_count_mismatch");
    }
    ownerResults[owner] = { countsMatch: true, observed };
  }
  if (input.repositories.some(({ owner }) => !(owner in input.owners))) {
    throw new InventoryAuditError("inventory_count_mismatch");
  }

  const canonical = JSON.stringify(stableValue(input));
  return {
    schemaVersion: 1,
    status: "passed",
    observedAt: input.observedAt,
    sourceMode: input.source.mode,
    policyVersion: input.policyVersion,
    inventoryDigest: `sha256:${createHash("sha256").update(canonical).digest("hex")}`,
    summary: recomputedSummary,
    owners: ownerResults,
  };
}
