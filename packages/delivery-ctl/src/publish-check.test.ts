import { describe, expect, it } from "vitest";
import {
  GitHubRestCheckClient,
  PublishCheckError,
  planPublishCheck,
  preflightPayloadDigest,
  publishCheck,
  type GitHubCheckClient,
  type GitHubCheckRequest,
  type PublishCheckInput,
  type RemoteCheckRun,
  type SignedPreflightEvidence,
} from "./publish-check.js";

function signedEvidence(): SignedPreflightEvidence {
  const evidence: SignedPreflightEvidence = {
    schemaVersion: 1,
    repository: "maxbec/example",
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    startedAt: "2026-07-28T20:00:00Z",
    finishedAt: "2026-07-28T20:02:00Z",
    runner: {
      class: "paperclip_ephemeral",
      id: "runner-example",
      controller: "maxbec-delivery-controller",
    },
    commands: [
      {
        command: "./scripts/delivery buildable",
        status: "passed",
        exitCode: 0,
        evidenceDigest: `sha256:${"c".repeat(64)}`,
      },
      {
        command: "./scripts/delivery affected",
        status: "passed",
        exitCode: 0,
        evidenceDigest: `sha256:${"d".repeat(64)}`,
      },
    ],
    releaseImpact: "patch",
    signature: {
      issuer: "flama-maxbec-delivery",
      subject: "maxbec-delivery-controller",
      algorithm: "github-app",
      payloadDigest: `sha256:${"0".repeat(64)}`,
      signedAt: "2026-07-28T20:02:01Z",
    },
  };
  return {
    ...evidence,
    signature: { ...evidence.signature, payloadDigest: preflightPayloadDigest(evidence) },
  };
}

function input(): PublishCheckInput {
  return {
    schemaVersion: 1,
    repository: {
      nameWithOwner: "maxbec/example",
      disposition: "in_scope",
      mutationAllowed: true,
      isFork: false,
      isArchived: false,
    },
    publisher: {
      controller: "maxbec-delivery-controller",
      appSlug: "flama-maxbec-delivery",
      tokenScope: "single-repository-checks-write",
      apiVersion: "2026-03-10",
    },
    evidence: signedEvidence(),
  };
}

class FakeCheckClient implements GitHubCheckClient {
  scopeAssertions: string[] = [];
  createCalls: GitHubCheckRequest[] = [];
  updateCalls: Array<{ readonly checkRunId: number; readonly request: GitHubCheckRequest }> = [];

  constructor(readonly existing: readonly RemoteCheckRun[] = []) {}

  async assertSingleRepositoryScope(repository: string): Promise<void> {
    this.scopeAssertions.push(repository);
  }

  async listCheckRuns(): Promise<readonly RemoteCheckRun[]> {
    return this.existing;
  }

  async updateCheckRun(
    _repository: string,
    checkRunId: number,
    request: GitHubCheckRequest,
  ): Promise<RemoteCheckRun> {
    this.updateCalls.push({ checkRunId, request });
    return {
      id: checkRunId,
      name: request.name,
      headSha: request.headSha,
      externalId: request.externalId,
      status: request.status,
      conclusion: request.conclusion,
      appSlug: "flama-maxbec-delivery",
    };
  }

  async createCheckRun(_repository: string, request: GitHubCheckRequest): Promise<RemoteCheckRun> {
    this.createCalls.push(request);
    return {
      id: 42,
      name: request.name,
      headSha: request.headSha,
      externalId: request.externalId,
      status: request.status,
      conclusion: request.conclusion,
      appSlug: "flama-maxbec-delivery",
    };
  }
}

describe("Flama preflight check publication", () => {
  it("plans a minimal exact-SHA success check without repository identifiers", () => {
    const result = planPublishCheck(input());

    expect(result).toMatchObject({
      status: "planned",
      headSha: "a".repeat(40),
      check: {
        name: "Flama Preflight",
        status: "completed",
        conclusion: "success",
      },
    });
    expect(JSON.stringify(result)).not.toContain("maxbec/example");
    expect(JSON.stringify(result)).not.toContain("runner-example");
  });

  it("publishes once and reuses an identical existing app check", async () => {
    const client = new FakeCheckClient();
    const created = await publishCheck(input(), client);

    expect(created).toMatchObject({
      status: "published",
      publication: { checkRunId: 42, appSlug: "flama-maxbec-delivery", reused: false },
    });
    expect(client.scopeAssertions).toEqual(["maxbec/example"]);
    expect(client.createCalls).toHaveLength(1);

    const check = client.createCalls[0];
    expect(check).toBeDefined();
    const existing = new FakeCheckClient([
      {
        id: 42,
        name: check?.name ?? "",
        headSha: check?.headSha ?? "",
        externalId: check?.externalId ?? null,
        status: check?.status ?? "",
        conclusion: check?.conclusion ?? null,
        appSlug: "flama-maxbec-delivery",
      },
    ]);
    const reused = await publishCheck(input(), existing);
    expect(reused).toMatchObject({ status: "published", publication: { reused: true } });
    expect(existing.createCalls).toHaveLength(0);
  });

  it("denies scope, digest, and publisher-identity mismatches before mutation", async () => {
    const valid = input();
    const fork = {
      ...valid,
      repository: { ...valid.repository, mutationAllowed: false, isFork: true },
    } as unknown as PublishCheckInput;
    expect(() => planPublishCheck(fork)).toThrow(
      new PublishCheckError("publish_check_scope_denied"),
    );

    const tampered = {
      ...valid,
      evidence: { ...valid.evidence, releaseImpact: "major" as const },
    };
    expect(() => planPublishCheck(tampered)).toThrow(
      new PublishCheckError("publish_check_digest_mismatch"),
    );

    const wrongApp = new FakeCheckClient([
      {
        id: 7,
        name: "Flama Preflight",
        headSha: valid.evidence.headSha,
        externalId: `flama-preflight:${valid.evidence.signature.payloadDigest}`,
        status: "completed",
        conclusion: "success",
        appSlug: "untrusted-app",
      },
    ]);
    await expect(publishCheck(valid, wrongApp)).rejects.toEqual(
      new PublishCheckError("github_check_conflict"),
    );
    expect(wrongApp.createCalls).toHaveLength(0);
  });

  it("uses a redacted environment token and discards GitHub error bodies", async () => {
    const protectedValue = ["ghs", "test", "only", "installation", "credential"].join("_");
    const requests: RequestInit[] = [];
    const client = new GitHubRestCheckClient(
      { FLAMA_GITHUB_APP_INSTALLATION_TOKEN: protectedValue },
      (async (_url: string | URL | Request, init?: RequestInit) => {
        requests.push(init ?? {});
        return new Response("response-content-must-not-escape", { status: 403 });
      }) as typeof fetch,
    );

    let caught: unknown;
    try {
      await client.assertSingleRepositoryScope("maxbec/example");
    } catch (error) {
      caught = error;
    }
    expect(caught).toEqual(new PublishCheckError("github_request_failed"));
    expect(JSON.stringify(caught)).not.toContain(protectedValue);
    expect(JSON.stringify(caught)).not.toContain("response-content-must-not-escape");
    expect(JSON.stringify(client)).not.toContain(protectedValue);
    expect((requests[0]?.headers as Record<string, string> | undefined)?.["Authorization"]).toBe(
      `Bearer ${protectedValue}`,
    );
  });

  it("verifies a single-repository installation scope before calling the versioned Checks API", async () => {
    const protectedValue = ["ghs", "test", "only", "scoped", "credential"].join("_");
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const responses = [
      new Response(
        JSON.stringify({ total_count: 1, repositories: [{ full_name: "maxbec/example" }] }),
        { status: 200 },
      ),
      new Response(JSON.stringify({ total_count: 0, check_runs: [] }), { status: 200 }),
      new Response(
        JSON.stringify({
          id: 42,
          name: "Flama Preflight",
          head_sha: "a".repeat(40),
          external_id: `flama-preflight:${signedEvidence().signature.payloadDigest}`,
          status: "completed",
          conclusion: "success",
          app: { slug: "flama-maxbec-delivery" },
        }),
        { status: 201 },
      ),
    ];
    const client = new GitHubRestCheckClient(
      { FLAMA_GITHUB_APP_INSTALLATION_TOKEN: protectedValue },
      (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        const response = responses.shift();
        if (response === undefined) throw new Error("unexpected request");
        return response;
      }) as typeof fetch,
    );

    await expect(publishCheck(input(), client)).resolves.toMatchObject({
      status: "published",
      publication: { checkRunId: 42, reused: false },
    });
    expect(calls.map(({ url }) => url)).toEqual([
      "https://api.github.com/installation/repositories?per_page=2",
      `https://api.github.com/repos/maxbec/example/commits/${"a".repeat(40)}/check-runs?check_name=Flama%20Preflight&filter=all&per_page=100`,
      "https://api.github.com/repos/maxbec/example/check-runs",
    ]);
    expect(calls.every(({ init }) => (init.headers as Record<string, string>)["X-GitHub-Api-Version"] === "2026-03-10")).toBe(true);
    const createBody = JSON.parse(String(calls[2]?.init.body)) as Record<string, unknown>;
    expect(createBody).toMatchObject({
      name: "Flama Preflight",
      head_sha: "a".repeat(40),
      status: "completed",
      conclusion: "success",
    });
    expect(JSON.stringify(calls.map(({ init }) => init.body))).not.toContain(protectedValue);
  });
});

/*
 * The Actions publisher announces an in-progress `Flama Preflight` check the
 * moment it starts, so the pull request shows what is running and where. The
 * verdict must then complete that same check run rather than sit beside it as
 * a second one: two checks of one name, one of them forever in progress, is
 * exactly the ambiguity the gates were written to refuse.
 */
describe("completing an announced check", () => {
  const pending = (over: Partial<RemoteCheckRun> = {}): RemoteCheckRun => ({
    id: 7,
    name: "Flama Preflight",
    headSha: "a".repeat(40),
    externalId: "flama-preflight:pending:123",
    status: "in_progress",
    conclusion: null,
    appSlug: "flama-maxbec-delivery",
    ...over,
  });

  it("completes the pending check the workflow announced instead of creating a second one", async () => {
    const client = new FakeCheckClient([pending()]);
    const result = await publishCheck(input(), client, { pendingCheckRunId: 7 });

    expect(result).toMatchObject({
      status: "published",
      check: { name: "Flama Preflight", status: "completed", conclusion: "success" },
      publication: { checkRunId: 7, reused: false },
    });
    expect(client.createCalls).toHaveLength(0);
    expect(client.updateCalls).toHaveLength(1);
    expect(client.updateCalls[0]?.checkRunId).toBe(7);
    expect(client.updateCalls[0]?.request.externalId).toMatch(/^flama-preflight:sha256:[0-9a-f]{64}$/u);
  });

  it("refuses to complete a pending check that belongs to another app or another head", async () => {
    for (const foreign of [pending({ appSlug: "untrusted-app" }), pending({ headSha: "b".repeat(40) })]) {
      const client = new FakeCheckClient([foreign]);
      await expect(publishCheck(input(), client, { pendingCheckRunId: 7 })).rejects.toEqual(
        new PublishCheckError("github_check_conflict"),
      );
      expect(client.updateCalls).toHaveLength(0);
      expect(client.createCalls).toHaveLength(0);
    }
  });

  it("creates the check when the pending one it was told about no longer exists", async () => {
    const client = new FakeCheckClient([]);
    const result = await publishCheck(input(), client, { pendingCheckRunId: 7 });

    expect(result).toMatchObject({ status: "published", publication: { checkRunId: 42, reused: false } });
    expect(client.updateCalls).toHaveLength(0);
    expect(client.createCalls).toHaveLength(1);
  });
});

/*
 * Consumers pinned to a platform older than the rename still look for a check
 * called `Paperclip Preflight`. The sweep publishes that name alongside the new
 * one while those consumers are re-rendered, so a rollout pull request merges
 * through its own, older, merge gate.
 */
describe("legacy check name", () => {
  it("publishes under the retired Paperclip name on request, with the same digest", async () => {
    const client = new FakeCheckClient();
    const result = await publishCheck(input(), client, { legacyName: true });

    expect(result).toMatchObject({
      status: "published",
      check: { name: "Paperclip Preflight", status: "completed", conclusion: "success" },
    });
    expect(result.check.externalId).toBe(`paperclip-preflight:${result.evidenceDigest}`);
    expect(client.createCalls[0]).toMatchObject({
      name: "Paperclip Preflight",
      output: { title: "Paperclip preflight passed" },
    });
  });

  it("plans under the new name by default", () => {
    const planned = planPublishCheck(input());
    expect(planned.check.name).toBe("Flama Preflight");
    expect(planned.check.externalId).toBe(`flama-preflight:${planned.evidenceDigest}`);
  });
});
