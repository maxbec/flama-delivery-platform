import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migration = new URL("../migrations/001_inbox_outbox.sql", import.meta.url);
const bindingsMigration = new URL("../migrations/002_repository_bindings.sql", import.meta.url);
const bindingIdentityMigration = new URL("../migrations/003_binding_identity.sql", import.meta.url);
const transitionAuthorizationMigration = new URL("../migrations/004_external_transition_authorizations.sql", import.meta.url);

describe("bridge database schema", () => {
  it("defines constrained queue states, FK indexes, and ready-work indexes", async () => {
    const sql = (await readFile(migration, "utf8")).toLowerCase();

    expect(sql).toContain("create schema if not exists flama_delivery");
    expect(sql).toMatch(/check\s*\(status in/);
    expect(sql).toContain("references flama_delivery.webhook_inbox (delivery_id)");
    expect(sql).toMatch(/create index(?: if not exists)? transition_outbox_delivery_id_idx/);
    expect(sql).toContain("where status in ('pending', 'retry')");
    expect(sql).not.toMatch(/\bvarchar\s*\(/);
    expect(sql).not.toMatch(/timestamp without time zone/);
  });

  it("fails closed on repository bindings and owner/company mismatches", async () => {
    const sql = (await readFile(bindingsMigration, "utf8")).toLowerCase();

    expect(sql).toContain("create table if not exists flama_delivery.repository_binding");
    expect(sql).toContain("check (not active or (not is_fork and not is_archived))");
    expect(sql).toContain("split_part(repository_name, '/', 1) = owner_name");
    expect(sql).toContain("owner_name = 'maxbec' and company = 'private'");
    expect(sql).toContain("owner_name = 'navigaite' and company = '// navigaite'");
    expect(sql).toContain("owner_name = 'edilio' and company = 'edilio'");
    expect(sql).not.toMatch(/insert into flama_delivery\.repository_binding/);
  });

  it("binds active rows to an exact GitHub identity, branch, and digest", async () => {
    const sql = (await readFile(bindingIdentityMigration, "utf8")).toLowerCase();

    expect(sql).toContain("github_repository_id bigint");
    expect(sql).toContain("default_branch text");
    expect(sql).toContain("binding_digest text");
    expect(sql).toContain("repository_binding_active_workspace_idx");
    expect(sql).not.toMatch(/insert into flama_delivery\.repository_binding/);
  });

  it("permits only controller-authorized external lifecycle edges", async () => {
    const sql = (await readFile(transitionAuthorizationMigration, "utf8")).toLowerCase();

    expect(sql).toContain("create table if not exists flama_delivery.external_transition_authorization");
    expect(sql).toContain("references flama_delivery.repository_binding (repository_name) on delete restrict");
    expect(sql).toContain("event_digest text not null");
    expect(sql).toContain("evidence_digest text not null");
    expect(sql).toContain("binding_digest text not null");
    expect(sql).toContain("awaiting_owner_approval");
    expect(sql).not.toMatch(/insert into flama_delivery\.external_transition_authorization/);
  });
});
