export interface WebhookEnvelope {
  readonly deliveryId: string;
  readonly eventName: string;
  readonly owner: string;
  readonly repository: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly receivedAt: Date;
}

export interface EnqueueWebhook {
  enqueue(envelope: WebhookEnvelope): Promise<"accepted" | "duplicate">;
}

export interface ClaimedWebhook extends WebhookEnvelope {
  readonly attempts: number;
}

export interface Transition {
  readonly deliveryId: string;
  readonly company: "Private" | "// Navigaite" | "Edilio";
  readonly transitionKind: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ClaimedTransition extends Transition {
  readonly id: string;
  readonly attempts: number;
}

export interface TransitionFailure {
  readonly id: string;
  readonly reasonCode: string;
  readonly maxAttempts: number;
}

export interface DeliveryFailure {
  readonly deliveryId: string;
  readonly reasonCode: string;
  readonly maxAttempts: number;
}
