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

  constructor(readonly existing: readonly RemoteCheckRun[] = []) {}

  async assertSingleRepositoryScope(repository: string): Promise<void> {
    this.scopeAssertions.push(repository);
  }

  async listCheckRuns(): Promise<readonly RemoteCheckRun[]> {
    return this.existing;
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

describe("Paperclip preflight check publication", () => {
  it("plans a minimal exact-SHA success check without repository identifiers", () => {
    const result = planPublishCheck(input());

    expect(result).toMatchObject({
      status: "planned",
      headSha: "a".repeat(40),
      check: {
        name: "Paperclip Preflight",
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
        name: "Paperclip Preflight",
        headSha: valid.evidence.headSha,
        externalId: `paperclip-preflight:${valid.evidence.signature.payloadDigest}`,
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
          name: "Paperclip Preflight",
          head_sha: "a".repeat(40),
          external_id: `paperclip-preflight:${signedEvidence().signature.payloadDigest}`,
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
      `https://api.github.com/repos/maxbec/example/commits/${"a".repeat(40)}/check-runs?check_name=Paperclip%20Preflight&filter=all&per_page=100`,
      "https://api.github.com/repos/maxbec/example/check-runs",
    ]);
    expect(calls.every(({ init }) => (init.headers as Record<string, string>)["X-GitHub-Api-Version"] === "2026-03-10")).toBe(true);
    const createBody = JSON.parse(String(calls[2]?.init.body)) as Record<string, unknown>;
    expect(createBody).toMatchObject({
      name: "Paperclip Preflight",
      head_sha: "a".repeat(40),
      status: "completed",
      conclusion: "success",
    });
    expect(JSON.stringify(calls.map(({ init }) => init.body))).not.toContain(protectedValue);
  });
});
