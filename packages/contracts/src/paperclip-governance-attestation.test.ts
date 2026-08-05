import { describe, expect, it } from "vitest";
import {
  createPaperclipGovernanceAttestation,
  verifyPaperclipGovernanceAttestationDigest,
} from "./paperclip-governance-attestation.js";

describe("Paperclip governance attestation contract", () => {
  it("binds the native controller run and checks to one deterministic digest", () => {
    const attestation = createPaperclipGovernanceAttestation({
      source: "paperclip-company-controller",
      company: "Private",
      controller: "maxbec-delivery-controller",
      runId: "11111111-1111-4111-8111-111111111111",
      observedAt: "2026-07-29T00:00:00.000Z",
      checks: { company: "compliant", controller: "compliant", lifecycles: "compliant" },
    });

    expect(attestation.evidenceDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(verifyPaperclipGovernanceAttestationDigest(attestation)).toBe(true);
    expect(verifyPaperclipGovernanceAttestationDigest({
      ...attestation,
      checks: { ...attestation.checks, lifecycles: "drift" },
    })).toBe(false);
  });
});
