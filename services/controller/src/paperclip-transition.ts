import { createHash } from "node:crypto";
import { SecretValue } from "../../bridge/src/config.js";
import {
  minimizedEventDigest,
  PaperclipPublicationError,
  validAuthorization,
  validEventEvidence,
  type AuthorizedTransition,
  type CompanyName,
  type TransitionAuthorizationStore,
} from "../../bridge/src/paperclip-publisher.js";
import type { PaperclipPublisher, PaperclipTransitionMessage } from "../../bridge/src/processor.js";

type FetchImplementation = (input: string | URL, init?: RequestInit) => Promise<Response>;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const maximumResponseBytes = 2 * 1_024 * 1_024;

export interface PaperclipCaseDetail {
  readonly caseId: string;
  readonly companyId: string;
  readonly pipelineId: string;
  readonly pipelineKey: string;
  readonly stageKey: string;
  readonly version: number;
  readonly terminalKind: string | null;
}

export interface PaperclipTransitionEvent {
  readonly type: string;
  readonly fromStageKey: string | null;
  readonly toStageKey: string | null;
  readonly reason: string | null;
}

export interface PaperclipTransitionApi {
  getCase(caseId: string): Promise<PaperclipCaseDetail>;
  listCaseEvents(caseId: string): Promise<readonly PaperclipTransitionEvent[]>;
  transitionCase(caseId: string, input: {
    readonly toStageKey: string;
    readonly expectedVersion: number;
    readonly reason: string;
  }): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reasonFor(idempotencyKey: string): string {
  return `flama-external:sha256:${createHash("sha256").update(idempotencyKey).digest("hex")}`;
}

function hasTransitionEvent(
  events: readonly PaperclipTransitionEvent[],
  authorization: AuthorizedTransition,
  reason: string,
): boolean {
  return events.some((event) => event.type === "transitioned" &&
    event.fromStageKey === authorization.fromStageKey && event.toStageKey === authorization.toStageKey &&
    event.reason === reason);
}

export class AuthorizedPaperclipPublisher implements PaperclipPublisher {
  constructor(
    private readonly company: CompanyName,
    private readonly companyId: string,
    private readonly authorizations: TransitionAuthorizationStore,
    private readonly api: PaperclipTransitionApi,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!uuidPattern.test(companyId)) throw new PaperclipPublicationError("paperclip_identity_unavailable");
  }

  async publish(message: PaperclipTransitionMessage): Promise<void> {
    const expectedKey = `github:${message.deliveryId}:${message.transitionKind}`;
    if (message.company !== this.company || message.idempotencyKey !== expectedKey) {
      throw new PaperclipPublicationError("authorization_scope_mismatch");
    }
    const eventDigest = minimizedEventDigest(message.payload);
    const authorization = await this.authorizations.resolve(message, eventDigest, this.now());
    if (authorization === undefined) throw new PaperclipPublicationError("authorization_missing");
    if (!validAuthorization(message, authorization, eventDigest)) {
      throw new PaperclipPublicationError("authorization_scope_mismatch");
    }
    if (!validEventEvidence(message, authorization)) {
      throw new PaperclipPublicationError("event_evidence_invalid");
    }
    if (authorization.alreadyPublished) return;

    const reason = reasonFor(message.idempotencyKey);
    const detail = await this.api.getCase(authorization.caseId);
    if (
      detail.caseId !== authorization.caseId || detail.companyId !== this.companyId ||
      detail.pipelineId !== authorization.pipelineId || detail.pipelineKey !== authorization.pipelineKey ||
      detail.terminalKind !== null
    ) throw new PaperclipPublicationError("paperclip_scope_mismatch");

    if (detail.stageKey !== authorization.fromStageKey) {
      const events = await this.api.listCaseEvents(authorization.caseId);
      if (!hasTransitionEvent(events, authorization, reason)) {
        throw new PaperclipPublicationError("paperclip_state_conflict");
      }
      await this.authorizations.markPublished(message.idempotencyKey, this.now());
      return;
    }

    await this.api.transitionCase(authorization.caseId, {
      toStageKey: authorization.toStageKey,
      expectedVersion: detail.version,
      reason,
    });
    const transitioned = await this.api.getCase(authorization.caseId);
    if (
      transitioned.caseId !== authorization.caseId || transitioned.companyId !== this.companyId ||
      transitioned.pipelineId !== authorization.pipelineId || transitioned.pipelineKey !== authorization.pipelineKey ||
      transitioned.version <= detail.version
    ) throw new PaperclipPublicationError("paperclip_scope_mismatch");
    if (transitioned.stageKey !== authorization.toStageKey) {
      const events = await this.api.listCaseEvents(authorization.caseId);
      if (!hasTransitionEvent(events, authorization, reason)) {
        throw new PaperclipPublicationError("paperclip_state_conflict");
      }
    }
    await this.authorizations.markPublished(message.idempotencyKey, this.now());
  }
}

interface PaperclipPublisherConfig {
  readonly apiBase: string;
  readonly apiKey: SecretValue;
  readonly runId: string;
}

export function parsePaperclipPublisherConfig(
  environment: Readonly<Record<string, string | undefined>>,
): PaperclipPublisherConfig {
  const rawBase = environment["PAPERCLIP_API_URL"];
  const rawKey = environment["PAPERCLIP_API_KEY"];
  const runId = environment["PAPERCLIP_RUN_ID"];
  if (
    rawBase === undefined || rawKey === undefined || runId === undefined ||
    rawKey.length < 20 || rawKey.length > 4_096 || /[\r\n]/u.test(rawKey) || !uuidPattern.test(runId)
  ) throw new PaperclipPublicationError("paperclip_identity_unavailable");
  let url: URL;
  try {
    url = new URL(rawBase);
  } catch {
    throw new PaperclipPublicationError("paperclip_identity_unavailable");
  }
  const localHttp = url.protocol === "http:" && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !localHttp) || url.username || url.password || url.search || url.hash) {
    throw new PaperclipPublicationError("paperclip_identity_unavailable");
  }
  return { apiBase: url.toString().replace(/\/+$/u, ""), apiKey: new SecretValue(rawKey), runId };
}

async function boundedJson(response: Response): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maximumResponseBytes) {
    throw new PaperclipPublicationError("paperclip_response_invalid");
  }
  if (response.body === null) throw new PaperclipPublicationError("paperclip_response_invalid");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumResponseBytes) {
      await reader.cancel();
      throw new PaperclipPublicationError("paperclip_response_invalid");
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString("utf8")) as unknown;
  } catch {
    throw new PaperclipPublicationError("paperclip_response_invalid");
  }
}

export class PaperclipRestTransitionApi implements PaperclipTransitionApi {
  readonly #apiBase: string;
  readonly #apiKey: SecretValue;
  readonly #runId: string;

  constructor(
    environment: Readonly<Record<string, string | undefined>>,
    private readonly fetchImplementation: FetchImplementation = fetch,
  ) {
    const config = parsePaperclipPublisherConfig(environment);
    this.#apiBase = config.apiBase;
    this.#apiKey = config.apiKey;
    this.#runId = config.runId;
  }

  async #request(path: string, init: RequestInit = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.#apiBase}${path}`, {
        ...init,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.#apiKey.reveal()}`,
          "x-paperclip-run-id": this.#runId,
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new PaperclipPublicationError("paperclip_unavailable");
    }
    if (!response.ok) throw new PaperclipPublicationError("paperclip_unavailable");
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") throw new PaperclipPublicationError("paperclip_response_invalid");
    return boundedJson(response);
  }

  async getCase(caseId: string): Promise<PaperclipCaseDetail> {
    if (!uuidPattern.test(caseId)) throw new PaperclipPublicationError("paperclip_scope_mismatch");
    const value = await this.#request(`/api/cases/${encodeURIComponent(caseId)}`);
    if (!isRecord(value) || !isRecord(value["case"]) || !isRecord(value["stage"]) || !isRecord(value["pipeline"])) {
      throw new PaperclipPublicationError("paperclip_response_invalid");
    }
    const caseValue = value["case"];
    const stage = value["stage"];
    const pipeline = value["pipeline"];
    const detail: PaperclipCaseDetail = {
      caseId: typeof caseValue["id"] === "string" ? caseValue["id"] : "",
      companyId: typeof caseValue["companyId"] === "string" ? caseValue["companyId"] : "",
      pipelineId: typeof caseValue["pipelineId"] === "string" ? caseValue["pipelineId"] : "",
      pipelineKey: typeof pipeline["key"] === "string" ? pipeline["key"] : "",
      stageKey: typeof stage["key"] === "string" ? stage["key"] : "",
      version: typeof caseValue["version"] === "number" ? caseValue["version"] : 0,
      terminalKind: caseValue["terminalKind"] === null || typeof caseValue["terminalKind"] === "string"
        ? caseValue["terminalKind"]
        : "invalid",
    };
    if (
      !uuidPattern.test(detail.caseId) || !uuidPattern.test(detail.companyId) || !uuidPattern.test(detail.pipelineId) ||
      pipeline["id"] !== detail.pipelineId || pipeline["companyId"] !== detail.companyId ||
      !/^[a-z][a-z0-9-]{0,119}$/u.test(detail.pipelineKey) || !/^[a-z][a-z0-9_]{0,119}$/u.test(detail.stageKey) ||
      !Number.isSafeInteger(detail.version) || detail.version < 1
    ) throw new PaperclipPublicationError("paperclip_response_invalid");
    return detail;
  }

  async listCaseEvents(caseId: string): Promise<readonly PaperclipTransitionEvent[]> {
    if (!uuidPattern.test(caseId)) throw new PaperclipPublicationError("paperclip_scope_mismatch");
    const events: PaperclipTransitionEvent[] = [];
    for (let offset = 0; offset < 10_000; offset += 100) {
      const value = await this.#request(`/api/cases/${encodeURIComponent(caseId)}/events?limit=100&offset=${offset}`);
      if (!isRecord(value) || !Array.isArray(value["items"]) || !isRecord(value["pagination"])) {
        throw new PaperclipPublicationError("paperclip_response_invalid");
      }
      for (const item of value["items"] as unknown[]) {
        if (!isRecord(item)) throw new PaperclipPublicationError("paperclip_response_invalid");
        const payload = isRecord(item["payload"]) ? item["payload"] : {};
        const fromStage = isRecord(item["fromStage"]) ? item["fromStage"] : undefined;
        const toStage = isRecord(item["toStage"]) ? item["toStage"] : undefined;
        events.push({
          type: typeof item["type"] === "string" ? item["type"] : "",
          fromStageKey: typeof fromStage?.["key"] === "string" ? fromStage["key"] : null,
          toStageKey: typeof toStage?.["key"] === "string" ? toStage["key"] : null,
          reason: typeof payload["reason"] === "string" ? payload["reason"] : null,
        });
      }
      const pagination = value["pagination"];
      if (pagination["hasMore"] === false && pagination["nextOffset"] === null) return events;
      if (pagination["hasMore"] !== true || pagination["nextOffset"] !== offset + 100) {
        throw new PaperclipPublicationError("paperclip_response_invalid");
      }
    }
    throw new PaperclipPublicationError("paperclip_response_invalid");
  }

  async transitionCase(caseId: string, input: {
    readonly toStageKey: string;
    readonly expectedVersion: number;
    readonly reason: string;
  }): Promise<void> {
    if (
      !uuidPattern.test(caseId) || !/^[a-z][a-z0-9_]{0,119}$/u.test(input.toStageKey) ||
      !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1 ||
      !/^flama-external:sha256:[0-9a-f]{64}$/u.test(input.reason)
    ) throw new PaperclipPublicationError("paperclip_scope_mismatch");
    const value = await this.#request(`/api/cases/${encodeURIComponent(caseId)}/transition`, {
      method: "POST",
      body: JSON.stringify(input),
    });
    if (
      !isRecord(value) || !isRecord(value["case"]) || value["case"]["id"] !== caseId ||
      value["case"]["version"] !== input.expectedVersion + 1
    ) throw new PaperclipPublicationError("paperclip_response_invalid");
  }
}
