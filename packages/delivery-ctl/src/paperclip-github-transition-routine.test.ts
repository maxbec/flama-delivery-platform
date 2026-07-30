import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  applyPaperclipGithubTransitionRoutine,
  type InfisicalRoutineSecretStore,
  type InfisicalSecretMetadata,
  InfisicalRestRoutineSecretStore,
  type PaperclipGithubTransitionRoutineContract,
  PaperclipGithubTransitionRoutineError,
  type PaperclipGithubTransitionRoutineInput,
  planPaperclipGithubTransitionRoutine,
} from "./paperclip-github-transition-routine.js";
import {
  PaperclipRestRoutinesClient,
  type PaperclipRoutineCreateInput,
  type PaperclipRoutineDetail,
  type PaperclipWebhookRoutinesClient,
  type PaperclipWebhookSecretMaterial,
} from "./paperclip-routines.js";

const now = new Date("2026-07-30T12:00:00.000Z");
const input: PaperclipGithubTransitionRoutineInput = {
  schemaVersion: 1,
  company: { id: "11111111-1111-4111-8111-111111111111", name: "Private" },
  controller: "maxbec-delivery-controller",
  controllerAgentId: "22222222-2222-4222-8222-222222222222",
  projectId: "33333333-3333-4333-8333-333333333333",
  infisical: {
    sourceOfTruth: true,
    projectId: "44444444-4444-4444-8444-444444444444",
    environment: "production",
    secretPath: "/flama/paperclip/private",
    credentialSource: "infisical-oidc",
  },
  paperclipSecretStorageException: {
    key: "PAPERCLIP_ROUTINE_WEBHOOK_SECRET",
    destination: "provider_native_secret",
    reason: "Paperclip retains the verifier copy required to authenticate its generated routine trigger.",
    owner: "delivery-platform",
    scope: "provider",
    rotationDays: 90,
    expiresAt: "2027-07-30",
    reviewAfter: "2026-12-31",
    status: "approved",
  },
  mutationAllowed: true,
};
const contract = JSON.parse(
  await readFile(new URL("../../../routines/github-transition.json", import.meta.url), "utf8"),
) as PaperclipGithubTransitionRoutineContract;

class FakePaperclip implements PaperclipWebhookRoutinesClient {
  routine: PaperclipRoutineDetail | undefined;
  createdRoutines = 0;
  createdTriggers = 0;
  rotations = 0;
  agentStatus = "paused";
  readonly #routineId = "55555555-5555-4555-8555-555555555555";
  readonly #triggerId = "66666666-6666-4666-8666-666666666666";

  constructor(existingTrigger = false) {
    if (existingTrigger) {
      this.routine = this.baseRoutine([this.trigger("2026-07-30T10:00:00.000Z")]);
    }
  }

  private description(): string {
    return planPaperclipGithubTransitionRoutine(input, contract, now).contractDigest;
  }

  private trigger(lastRotatedAt: string): PaperclipRoutineDetail["triggers"][number] {
    return {
      id: this.#triggerId,
      kind: "webhook",
      label: contract.trigger.label,
      enabled: true,
      cronExpression: null,
      timezone: null,
      publicId: "public-trigger-id",
      signingMode: "hmac_sha256",
      replayWindowSec: 300,
      lastRotatedAt,
    };
  }

  private baseRoutine(triggers: PaperclipRoutineDetail["triggers"]): PaperclipRoutineDetail {
    return {
      id: this.#routineId,
      companyId: input.company.id,
      projectId: input.projectId,
      folderId: null,
      goalId: null,
      parentIssueId: null,
      title: contract.title,
      description: `Managed by flama-delivery-platform; key=${contract.key}; contract=${this.description()}\n\n${contract.description}`,
      assigneeAgentId: input.controllerAgentId,
      priority: "high",
      status: "paused",
      concurrencyPolicy: "always_enqueue",
      catchUpPolicy: "skip_missed",
      variables: [],
      triggers,
    };
  }

  private material(lastRotatedAt: string): PaperclipWebhookSecretMaterial {
    return {
      trigger: { id: this.#triggerId, publicId: "public-trigger-id", lastRotatedAt },
      webhookUrl: "https://paperclip.example.test/api/routine-triggers/public/public-trigger-id/fire",
      webhookSecret: `test-only-${"x".repeat(32)}-${lastRotatedAt}`,
    };
  }

  async getCompany() {
    return { id: input.company.id, name: input.company.name, status: "active" };
  }

  async getAgent() {
    return {
      id: input.controllerAgentId,
      companyId: input.company.id,
      name: input.controller,
      role: "devops",
      adapterType: "process",
      budgetMonthlyCents: 0,
      status: this.agentStatus,
    };
  }

  async getProject() {
    return { id: input.projectId, companyId: input.company.id, status: "in_progress", archivedAt: null };
  }

  async listRoutines() {
    return this.routine === undefined ? [] : [{ id: this.routine.id, title: this.routine.title }];
  }

  async createRoutine(_companyId: string, _routine: PaperclipRoutineCreateInput) {
    this.createdRoutines += 1;
    this.routine = this.baseRoutine([]);
    return { id: this.#routineId };
  }

  async getRoutine() {
    if (this.routine === undefined) throw new Error("test routine missing");
    return this.routine;
  }

  async createScheduleTrigger(): Promise<void> {
    throw new Error("schedule trigger must not be used");
  }

  async createWebhookTrigger() {
    this.createdTriggers += 1;
    const lastRotatedAt = "2026-07-30T10:00:00.000Z";
    this.routine = this.baseRoutine([this.trigger(lastRotatedAt)]);
    return this.material(lastRotatedAt);
  }

  async rotateWebhookTriggerSecret() {
    this.rotations += 1;
    const lastRotatedAt = `2026-07-30T10:00:0${this.rotations}.000Z`;
    this.routine = this.baseRoutine([this.trigger(lastRotatedAt)]);
    return this.material(lastRotatedAt);
  }
}

class FakeInfisical implements InfisicalRoutineSecretStore {
  readonly entries = new Map<string, { value: string; metadata: readonly InfisicalSecretMetadata[] }>();
  writes = 0;
  failWriteNumber: number | undefined;

  async readMetadata(
    _mapping: PaperclipGithubTransitionRoutineInput["infisical"],
    secretName: "PAPERCLIP_ROUTINE_WEBHOOK_URL" | "PAPERCLIP_ROUTINE_WEBHOOK_SECRET",
  ) {
    return this.entries.get(secretName)?.metadata ?? null;
  }

  async upsertSecret(
    _mapping: PaperclipGithubTransitionRoutineInput["infisical"],
    secretName: "PAPERCLIP_ROUTINE_WEBHOOK_URL" | "PAPERCLIP_ROUTINE_WEBHOOK_SECRET",
    value: string,
    metadata: readonly InfisicalSecretMetadata[],
  ): Promise<void> {
    this.writes += 1;
    if (this.writes === this.failWriteNumber) throw new Error("test-only write failure");
    this.entries.set(secretName, { value, metadata });
  }
}

describe("Paperclip GitHub-transition routine provisioning", () => {
  it("plans a paused HMAC trigger with no identity or secret material", () => {
    const result = planPaperclipGithubTransitionRoutine(input, contract, now);
    expect(result).toMatchObject({
      status: "planned",
      routineDisposition: "planned",
      triggerDisposition: "planned",
      infisicalSynced: false,
      trigger: { kind: "webhook", signingMode: "hmac_sha256", replayWindowSeconds: 300 },
    });
    expect(JSON.stringify(result)).not.toContain(input.company.id);
    expect(JSON.stringify(result)).not.toContain(input.infisical.projectId);
    expect(JSON.stringify(result)).not.toContain(input.infisical.secretPath);
  });

  it("creates, captures once in Infisical, and reuses exact receipts without rotation", async () => {
    const paperclip = new FakePaperclip();
    const infisical = new FakeInfisical();
    const first = await applyPaperclipGithubTransitionRoutine(input, contract, paperclip, infisical, now);
    expect(first).toMatchObject({
      status: "applied",
      routineDisposition: "created",
      triggerDisposition: "created",
      infisicalSynced: true,
    });
    expect(paperclip.createdRoutines).toBe(1);
    expect(paperclip.createdTriggers).toBe(1);
    expect(paperclip.rotations).toBe(0);
    expect(infisical.entries.size).toBe(2);

    const second = await applyPaperclipGithubTransitionRoutine(input, contract, paperclip, infisical, now);
    expect(second).toMatchObject({ routineDisposition: "reused", triggerDisposition: "reused" });
    expect(paperclip.rotations).toBe(0);
    const serialized = JSON.stringify(second);
    expect(serialized).not.toContain("public-trigger-id");
    expect(serialized).not.toContain("test-only-");
  });

  it("rotates once to recover an interrupted two-secret Infisical handoff", async () => {
    const paperclip = new FakePaperclip();
    const infisical = new FakeInfisical();
    infisical.failWriteNumber = 2;
    await expect(
      applyPaperclipGithubTransitionRoutine(input, contract, paperclip, infisical, now),
    ).rejects.toMatchObject({ code: "infisical_sync_failed" });
    expect(infisical.entries.size).toBe(1);
    expect(paperclip.rotations).toBe(0);

    infisical.failWriteNumber = undefined;
    const recovered = await applyPaperclipGithubTransitionRoutine(input, contract, paperclip, infisical, now);
    expect(recovered).toMatchObject({ triggerDisposition: "rotated", infisicalSynced: true });
    expect(paperclip.rotations).toBe(1);
    expect(infisical.entries.size).toBe(2);
  });

  it("rotates an exact receipt when the approved rotation interval is due", async () => {
    const paperclip = new FakePaperclip();
    const infisical = new FakeInfisical();
    await applyPaperclipGithubTransitionRoutine(input, contract, paperclip, infisical, now);
    const afterRotationInterval = new Date("2026-10-29T12:00:00.000Z");
    const rotated = await applyPaperclipGithubTransitionRoutine(
      input,
      contract,
      paperclip,
      infisical,
      afterRotationInterval,
    );
    expect(rotated).toMatchObject({ triggerDisposition: "rotated", infisicalSynced: true });
    expect(paperclip.rotations).toBe(1);
  });

  it("refuses pending approval, active routines, and due exception review", async () => {
    const pending = new FakePaperclip();
    pending.agentStatus = "pending_approval";
    await expect(
      applyPaperclipGithubTransitionRoutine(input, contract, pending, new FakeInfisical(), now),
    ).rejects.toMatchObject({ code: "paperclip_agent_approval_required" });

    const drifted = new FakePaperclip(true);
    if (drifted.routine === undefined) throw new Error("test setup failed");
    drifted.routine = { ...drifted.routine, status: "active" };
    await expect(
      applyPaperclipGithubTransitionRoutine(input, contract, drifted, new FakeInfisical(), now),
    ).rejects.toMatchObject({ code: "paperclip_routine_drift" });

    const due = {
      ...input,
      paperclipSecretStorageException: {
        ...input.paperclipSecretStorageException,
        reviewAfter: "2026-07-30",
      },
    } as PaperclipGithubTransitionRoutineInput;
    expect(() => planPaperclipGithubTransitionRoutine(due, contract, now)).toThrow(
      expect.objectContaining<Partial<PaperclipGithubTransitionRoutineError>>({
        code: "paperclip_secret_exception_invalid",
      }),
    );
  });

  it("uses the released Paperclip webhook endpoints and validates one-time material", async () => {
    const requests: Array<{ url: string; method: string | undefined }> = [];
    const client = new PaperclipRestRoutinesClient(
      { PAPERCLIP_API_URL: "http://127.0.0.1:3100", PAPERCLIP_API_KEY: "test-only-paperclip-routine-key" },
      async (request, init) => {
        requests.push({ url: String(request), method: init?.method });
        return Response.json({
          trigger: {
            id: "66666666-6666-4666-8666-666666666666",
            publicId: "public-trigger-id",
            lastRotatedAt: "2026-07-30T10:00:00.000Z",
          },
          secretMaterial: {
            webhookUrl: "http://127.0.0.1:3100/api/routine-triggers/public/public-trigger-id/fire",
            webhookSecret: "x".repeat(32),
          },
        }, { status: 201 });
      },
    );
    await expect(client.createWebhookTrigger("55555555-5555-4555-8555-555555555555", {
      kind: "webhook",
      label: "flama-github-transition-v1",
      enabled: true,
      signingMode: "hmac_sha256",
      replayWindowSec: 300,
    })).resolves.toMatchObject({ trigger: { publicId: "public-trigger-id" } });
    expect(requests[0]).toEqual({
      url: "http://127.0.0.1:3100/api/routines/55555555-5555-4555-8555-555555555555/triggers",
      method: "POST",
    });
  });
});

describe("Infisical routine secret receipt client", () => {
  const mapping = input.infisical;
  const metadata: readonly InfisicalSecretMetadata[] = [
    { key: "flama_receipt_version", value: "1", isEncrypted: false },
  ];

  it("reads metadata without values and never consumes value-echoing write responses", async () => {
    const requests: Array<{ url: string; method: string | undefined; body: string | undefined }> = [];
    let reads = 0;
    const store = new InfisicalRestRoutineSecretStore(
      { INFISICAL_API_URL: "https://infisical.example.test", INFISICAL_TOKEN: "test-only-infisical-token-value" },
      async (request, init) => {
        requests.push({
          url: String(request),
          method: init?.method,
          body: typeof init?.body === "string" ? init.body : undefined,
        });
        if (init?.method === "GET") {
          reads += 1;
          if (reads === 1) return new Response(null, { status: 404 });
          return Response.json({
            secret: {
              secretKey: "PAPERCLIP_ROUTINE_WEBHOOK_SECRET",
              secretValue: "",
              secretMetadata: metadata,
            },
          });
        }
        return Response.json({ secret: { secretValue: "must-not-be-read" } });
      },
    );
    await store.upsertSecret(mapping, "PAPERCLIP_ROUTINE_WEBHOOK_SECRET", "test-only-generated-secret", metadata);
    await expect(store.readMetadata(mapping, "PAPERCLIP_ROUTINE_WEBHOOK_SECRET")).resolves.toEqual(metadata);
    expect(requests[0]?.url).toContain("viewSecretValue=false");
    expect(requests[0]?.url).toContain("expandSecretReferences=false");
    expect(requests[1]).toMatchObject({ method: "POST" });
    expect(requests[1]?.body).toContain("test-only-generated-secret");
  });

  it("suppresses rejected Infisical response bodies", async () => {
    const store = new InfisicalRestRoutineSecretStore(
      { INFISICAL_API_URL: "https://infisical.example.test", INFISICAL_TOKEN: "test-only-infisical-token-value" },
      async () => new Response("sensitive-provider-body", { status: 403 }),
    );
    let observed: unknown;
    try {
      await store.readMetadata(mapping, "PAPERCLIP_ROUTINE_WEBHOOK_SECRET");
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(PaperclipGithubTransitionRoutineError);
    expect(String(observed)).not.toContain("sensitive-provider-body");
  });
});
