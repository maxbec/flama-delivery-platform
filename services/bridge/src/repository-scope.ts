import type { Pool } from "pg";
import type { GitHubOwner } from "./github-event.js";

export interface RepositoryScope {
  allows(owner: GitHubOwner, repository: string): Promise<boolean>;
}

export class PostgresRepositoryScope implements RepositoryScope {
  constructor(private readonly pool: Pool) {}

  async allows(owner: GitHubOwner, repository: string): Promise<boolean> {
    const result = await this.pool.query<{ allowed: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM flama_delivery.repository_binding
         WHERE repository_name = $1
           AND owner_name = $2
           AND active
           AND NOT is_fork
           AND NOT is_archived
       ) AS allowed`,
      [repository, owner],
    );
    return result.rows[0]?.allowed === true;
  }
}
