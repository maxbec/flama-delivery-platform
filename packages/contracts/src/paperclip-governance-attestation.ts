import { createHash } from "node:crypto";

export type PaperclipCompanyName = "Private" | "// Navigaite" | "Edilio";
export type PaperclipDeliveryControllerName =
  | "maxbec-delivery-controller"
  | "navigaite-delivery-controller"
  | "edilio-delivery-controller";
export type PaperclipGovernanceCheck = "compliant" | "drift";

export interface PaperclipGovernanceAttestationPayload {
  readonly source: "paperclip-company-controller";
  readonly company: PaperclipCompanyName;
  readonly controller: PaperclipDeliveryControllerName;
  readonly runId: string;
  readonly observedAt: string;
  readonly checks: {
    readonly company: PaperclipGovernanceCheck;
    readonly controller: PaperclipGovernanceCheck;
    readonly lifecycles: PaperclipGovernanceCheck;
  };
}

export interface PaperclipGovernanceAttestation extends PaperclipGovernanceAttestationPayload {
  readonly evidenceDigest: string;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
}

export function paperclipGovernanceAttestationDigest(
  payload: PaperclipGovernanceAttestationPayload,
): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(stableValue(payload))).digest("hex")}`;
}

export function createPaperclipGovernanceAttestation(
  payload: PaperclipGovernanceAttestationPayload,
): PaperclipGovernanceAttestation {
  return { ...payload, evidenceDigest: paperclipGovernanceAttestationDigest(payload) };
}

export function verifyPaperclipGovernanceAttestationDigest(
  attestation: PaperclipGovernanceAttestation,
): boolean {
  const { evidenceDigest, ...payload } = attestation;
  return evidenceDigest === paperclipGovernanceAttestationDigest(payload);
}
