import type {
  ClaimedTransition,
  ClaimedWebhook,
  DeliveryFailure,
  Transition,
  TransitionFailure,
} from "./inbox.js";
import { githubOwner, transitionKindForMinimizedEvent } from "./github-event.js";
import type { RepositoryScope } from "./repository-scope.js";

export interface WebhookQueue {
  claimNext(workerId: string): Promise<ClaimedWebhook | undefined>;
  completeWithTransition(transition: Transition): Promise<void>;
  fail(failure: DeliveryFailure): Promise<"retry_scheduled" | "dead_lettered">;
}

export interface TransitionQueue {
  claimNextTransition(workerId: string): Promise<ClaimedTransition | undefined>;
  markTransitionPublished(id: string): Promise<void>;
  failTransition(failure: TransitionFailure): Promise<"retry_scheduled" | "dead_lettered">;
}

export interface PaperclipTransitionMessage {
  readonly idempotencyKey: string;
  readonly deliveryId: string;
  readonly company: "Private" | "// Navigaite" | "Edilio";
  readonly transitionKind: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface PaperclipPublisher {
  publish(message: PaperclipTransitionMessage): Promise<void>;
}

const companies = {
  maxbec: "Private",
  navigaite: "// Navigaite",
  "edilio-app": "Edilio",
} as const;

function deliveryIdIsSafe(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,128}$/u.test(value);
}

export async function processNextWebhook(
  queue: WebhookQueue,
  repositoryScope: RepositoryScope,
  workerId: string,
): Promise<"idle" | "completed" | "failed" | "infrastructure_failed"> {
  const claimed = await queue.claimNext(workerId);
  if (claimed === undefined) return "idle";
  const owner = githubOwner(claimed.repository);
  const transitionKind = transitionKindForMinimizedEvent(
    claimed.payload,
    claimed.eventName,
    claimed.repository,
  );
  if (
    owner === undefined || owner !== claimed.owner || transitionKind === undefined ||
    !deliveryIdIsSafe(claimed.deliveryId)
  ) {
    await queue.fail({
      deliveryId: claimed.deliveryId,
      reasonCode: "invalid_minimized_event",
      maxAttempts: 1,
    });
    return "failed";
  }
  if (!(await repositoryScope.allows(owner, claimed.repository))) {
    await queue.fail({
      deliveryId: claimed.deliveryId,
      reasonCode: "repository_scope_denied",
      maxAttempts: 1,
    });
    return "failed";
  }
  try {
    await queue.completeWithTransition({
      deliveryId: claimed.deliveryId,
      company: companies[owner],
      transitionKind,
      payload: claimed.payload,
    });
    return "completed";
  } catch {
    await queue.fail({
      deliveryId: claimed.deliveryId,
      reasonCode: "transition_persistence_failed",
      maxAttempts: 5,
    });
    return "infrastructure_failed";
  }
}

export async function processNextTransition(
  queue: TransitionQueue,
  publisher: PaperclipPublisher,
  workerId: string,
  maxAttempts = 5,
): Promise<"idle" | "published" | "failed" | "infrastructure_failed"> {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
    throw new Error("invalid transition retry bound");
  }
  const claimed = await queue.claimNextTransition(workerId);
  if (claimed === undefined) return "idle";
  try {
    await publisher.publish({
      idempotencyKey: `github:${claimed.deliveryId}:${claimed.transitionKind}`,
      deliveryId: claimed.deliveryId,
      company: claimed.company,
      transitionKind: claimed.transitionKind,
      payload: claimed.payload,
    });
    await queue.markTransitionPublished(claimed.id);
    return "published";
  } catch (error) {
    const publicationCode = typeof error === "object" && error !== null && "code" in error &&
      typeof error.code === "string"
      ? error.code
      : undefined;
    const permanentCodes = new Set([
      "authorization_scope_mismatch",
      "event_evidence_invalid",
      "paperclip_scope_mismatch",
    ]);
    const recognizedCodes = new Set([
      "authorization_missing",
      ...permanentCodes,
      "paperclip_identity_unavailable",
      "paperclip_response_invalid",
      "paperclip_state_conflict",
      "paperclip_unavailable",
      "routine_identity_unavailable",
      "routine_response_invalid",
      "routine_unavailable",
    ]);
    const infrastructureCodes = new Set([
      "paperclip_identity_unavailable",
      "paperclip_response_invalid",
      "paperclip_unavailable",
      "routine_identity_unavailable",
      "routine_response_invalid",
      "routine_unavailable",
    ]);
    const reasonCode = publicationCode !== undefined && recognizedCodes.has(publicationCode)
      ? publicationCode
      : "paperclip_unavailable";
    await queue.failTransition({
      id: claimed.id,
      reasonCode,
      maxAttempts: publicationCode !== undefined && permanentCodes.has(publicationCode) ? 1 : maxAttempts,
    });
    return infrastructureCodes.has(reasonCode)
      ? "infrastructure_failed"
      : "failed";
  }
}
