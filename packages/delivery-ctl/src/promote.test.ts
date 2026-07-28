import { describe, expect, it } from "vitest";
import {
  GitHubRestPromotionClient,
  planPromotion,
  promote,
  PromotionError,
  type BranchComparison,
  type IntegrationCheck,
  type PromotionClient,
  type PromotionInput,
  type PromotionPullRequest,
  type PromotionRequest,
} from "./promote.js";

function input(): PromotionInput {
  return {
    schemaVersion: 1,
    repository: {
      nameWithOwner: "maxbec/example",
      disposition: "in_scope",
      mutationAllowed: true,
      isFork: false,
      isArchived: false,
    },
    profile: "major",
    publisher: {
      controller: "maxbec-delivery-controller",
      appSlug: "flama-maxbec-delivery",
      tokenScope: "single-repository-pull-requests-write",
      apiVersion: "2026-03-10",
    },
    promotion: {
      sourceBranch: "dev",
      targetBranch: "main",
      sourceSha: "a".repeat(40),
      targetSha: "b".repeat(40),
      integrationEvidenceDigest: `sha256:${"c".repeat(64)}`,
    },
  };
}

class FakePromotionClient implements PromotionClient {
  scopeAssertions: string[] = [];
  createRequests: PromotionRequest[] = [];

  constructor(readonly existing: readonly PromotionPullRequest[] = []) {}

  async assertSingleRepositoryScope(repository: string): Promise<void> {
    this.scopeAssertions.push(repository);
  }

  async getBranch(_repository: string, branch: "dev" | "main") {
    return {
      name: branch,
      sha: branch === "dev" ? "a".repeat(40) : "b".repeat(40),
      protected: true,
    } as const;
  }

  async compareBranches(): Promise<BranchComparison> {
    return { status: "ahead" as const, aheadBy: 2, behindBy: 0 };
  }

  async listIntegrationChecks(): Promise<readonly IntegrationCheck[]> {
    return [{
      id: 22,
      name: "Paperclip Integration Smoke",
      headSha: "a".repeat(40),
      externalId: `paperclip-integration:sha256:${"c".repeat(64)}`,
      status: "completed",
      conclusion: "success",
      appSlug: "flama-maxbec-delivery",
    }];
  }

  async listPromotionPullRequests(): Promise<readonly PromotionPullRequest[]> {
    return this.existing;
  }

  async createPromotionPullRequest(
    _repository: string,
    request: PromotionRequest,
  ): Promise<PromotionPullRequest> {
    this.createRequests.push(request);
    return {
      number: 41,
      state: "open",
      headBranch: "dev",
      baseBranch: "main",
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      authorLogin: "flama-maxbec-delivery[bot]",
    };
  }
}

describe("Major profile promotion", () => {
  it("plans an exact dev-to-main promotion without exposing repository identity", () => {
    const result = planPromotion(input());

    expect(result).toMatchObject({
      status: "planned",
      profile: "major",
      sourceSha: "a".repeat(40),
      targetSha: "b".repeat(40),
      check: { name: "Paperclip Integration Smoke", conclusion: "success" },
      promotion: { sourceBranch: "dev", targetBranch: "main", action: "create_or_reuse" },
    });
    expect(JSON.stringify(result)).not.toContain("maxbec/example");
    expect(JSON.stringify(result)).not.toContain("flama-maxbec-delivery");
  });

  it("creates once and reuses the exact app-authored open promotion", async () => {
    const client = new FakePromotionClient();
    const created = await promote(input(), client);

    expect(created).toMatchObject({
      status: "published",
      promotion: { pullRequestNumber: 41, action: "created" },
    });
    expect(client.scopeAssertions).toEqual(["maxbec/example"]);
    expect(client.createRequests).toHaveLength(1);

    const existing = new FakePromotionClient([{
      number: 41,
      state: "open",
      headBranch: "dev",
      baseBranch: "main",
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      authorLogin: "flama-maxbec-delivery[bot]",
    }]);
    const reused = await promote(input(), existing);
    expect(reused).toMatchObject({
      status: "published",
      promotion: { pullRequestNumber: 41, action: "reused" },
    });
    expect(existing.createRequests).toHaveLength(0);
  });

  it("fails closed on scope, branch ancestry, evidence, and PR identity mismatches", async () => {
    const valid = input();
    const forked = {
      ...valid,
      repository: { ...valid.repository, isFork: true, mutationAllowed: false },
    } as unknown as PromotionInput;
    expect(() => planPromotion(forked)).toThrow(new PromotionError("promotion_scope_denied"));

    const behind = new FakePromotionClient();
    behind.compareBranches = async () => ({ status: "diverged", aheadBy: 2, behindBy: 1 });
    await expect(promote(valid, behind)).rejects.toEqual(
      new PromotionError("promotion_ancestry_invalid"),
    );
    expect(behind.createRequests).toHaveLength(0);

    const wrongCheck = new FakePromotionClient();
    wrongCheck.listIntegrationChecks = async () => [];
    await expect(promote(valid, wrongCheck)).rejects.toEqual(
      new PromotionError("promotion_evidence_invalid"),
    );

    const wrongAuthor = new FakePromotionClient([{
      number: 41,
      state: "open",
      headBranch: "dev",
      baseBranch: "main",
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      authorLogin: "untrusted-user",
    }]);
    await expect(promote(valid, wrongAuthor)).rejects.toEqual(
      new PromotionError("promotion_pull_request_conflict"),
    );
  });

  it("uses a redacted installation token and discards GitHub error bodies", async () => {
    const protectedValue = ["ghs", "test", "promotion", "credential"].join("_");
    const responseContent = "response-content-must-not-escape";
    const requests: RequestInit[] = [];
    const client = new GitHubRestPromotionClient(
      { FLAMA_GITHUB_APP_INSTALLATION_TOKEN: protectedValue },
      (async (_url: string | URL | Request, init?: RequestInit) => {
        requests.push(init ?? {});
        return new Response(responseContent, { status: 403 });
      }) as typeof fetch,
    );

    let caught: unknown;
    try {
      await client.assertSingleRepositoryScope("maxbec/example");
    } catch (error) {
      caught = error;
    }
    expect(caught).toEqual(new PromotionError("github_request_failed"));
    expect(JSON.stringify(caught)).not.toContain(protectedValue);
    expect(JSON.stringify(caught)).not.toContain(responseContent);
    expect(JSON.stringify(client)).not.toContain(protectedValue);
    expect((requests[0]?.headers as Record<string, string> | undefined)?.["Authorization"]).toBe(
      `Bearer ${protectedValue}`,
    );
  });

  it("proves repository scope and exact remote state before creating the PR", async () => {
    const protectedValue = ["ghs", "test", "scoped", "promotion"].join("_");
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const responses = [
      new Response(JSON.stringify({
        total_count: 1,
        repositories: [{ full_name: "maxbec/example" }],
      }), { status: 200 }),
      new Response(JSON.stringify({
        name: "dev",
        protected: true,
        commit: { sha: "a".repeat(40) },
      }), { status: 200 }),
      new Response(JSON.stringify({
        name: "main",
        protected: true,
        commit: { sha: "b".repeat(40) },
      }), { status: 200 }),
      new Response(JSON.stringify({ status: "ahead", ahead_by: 2, behind_by: 0 }), {
        status: 200,
      }),
      new Response(JSON.stringify({
        check_runs: [{
          id: 22,
          name: "Paperclip Integration Smoke",
          head_sha: "a".repeat(40),
          external_id: `paperclip-integration:sha256:${"c".repeat(64)}`,
          status: "completed",
          conclusion: "success",
          app: { slug: "flama-maxbec-delivery" },
        }],
      }), { status: 200 }),
      new Response("[]", { status: 200 }),
      new Response(JSON.stringify({
        number: 41,
        state: "open",
        head: { ref: "dev", sha: "a".repeat(40) },
        base: { ref: "main", sha: "b".repeat(40) },
        user: { login: "flama-maxbec-delivery[bot]" },
      }), { status: 201 }),
    ];
    const client = new GitHubRestPromotionClient(
      { FLAMA_GITHUB_APP_INSTALLATION_TOKEN: protectedValue },
      (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        const response = responses.shift();
        if (response === undefined) throw new Error("unexpected request");
        return response;
      }) as typeof fetch,
    );

    const result = await promote(input(), client);
    expect(result).toMatchObject({
      status: "published",
      promotion: { action: "created", pullRequestNumber: 41 },
    });
    expect(calls).toHaveLength(7);
    expect(calls[0]?.url).toContain("/installation/repositories?per_page=2");
    expect(calls[3]?.url).toContain(`/compare/${"b".repeat(40)}...${"a".repeat(40)}`);
    expect(calls[4]?.url).toContain("check_name=Paperclip%20Integration%20Smoke");
    expect(calls[6]?.init.method).toBe("POST");
    expect(calls.every(({ init }) =>
      (init.headers as Record<string, string>)["Authorization"] === `Bearer ${protectedValue}`
    )).toBe(true);
  });
});
