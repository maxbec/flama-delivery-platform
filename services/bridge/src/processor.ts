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
  edilio: "Edilio",
} as const;

function deliveryIdIsSafe(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,128}$/u.test(value);
}

export async function processNextWebhook(
  queue: WebhookQueue,
  repositoryScope: RepositoryScope,
  workerId: string,
): Promise<"idle" | "completed" | "failed"> {
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
    return "failed";
  }
}

export async function processNextTransition(
  queue: TransitionQueue,
  publisher: PaperclipPublisher,
  workerId: string,
): Promise<"idle" | "published" | "failed"> {
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
  } catch {
    await queue.failTransition({
      id: claimed.id,
      reasonCode: "paperclip_unavailable",
      maxAttempts: 5,
    });
    return "failed";
  }
}
