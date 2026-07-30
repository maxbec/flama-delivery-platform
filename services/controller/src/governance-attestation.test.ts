import { mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyPaperclipGovernanceAttestationDigest } from "../../../packages/contracts/src/paperclip-governance-attestation.js";
import {
  attestPaperclipGovernance,
  writePaperclipGovernanceAttestation,
  type PaperclipGovernanceObservation,
} from "./governance-attestation.js";

const observation: PaperclipGovernanceObservation = {
  companyId: "11111111-1111-4111-8111-111111111111",
  controllerId: "22222222-2222-4222-8222-222222222222",
  controllerName: "maxbec-delivery-controller",
  runId: "33333333-3333-4333-8333-333333333333",
  observedAt: "2026-07-29T00:00:00.000Z",
  company: { id: "11111111-1111-4111-8111-111111111111", name: "Private", status: "active" },
  controller: {
    id: "22222222-2222-4222-8222-222222222222",
    companyId: "11111111-1111-4111-8111-111111111111",
    name: "maxbec-delivery-controller",
    role: "devops",
    adapterType: "process",
    budgetMonthlyCents: 0,
    status: "running",
    desiredSkills: ["flama-paperclip-delivery"],
    permissions: { canCreateAgents: false, canCreateSkills: false, canAssignTasks: false },
    metadata: { managedBy: "flama-delivery-platform", topologyVersion: 1 },
  },
  pipelines: [
    { key: "flama-project-bootstrap-v1", enforceTransitions: true, archivedAt: null },
    { key: "flama-feature-fix-v1", enforceTransitions: true, archivedAt: null },
    { key: "flama-release-deployment-v1", enforceTransitions: true, archivedAt: null },
  ],
};

describe("native Paperclip governance attestations", () => {
  it("binds compliant state to the exact company-controller run", () => {
    const attestation = attestPaperclipGovernance(observation);
    expect(attestation).toMatchObject({
      source: "paperclip-company-controller",
      company: "Private",
      controller: "maxbec-delivery-controller",
      runId: observation.runId,
      checks: { company: "compliant", controller: "compliant", lifecycles: "compliant" },
    });
    expect(verifyPaperclipGovernanceAttestationDigest(attestation)).toBe(true);
  });

  it("reports drift without granting mutation authority", () => {
    const attestation = attestPaperclipGovernance({
      ...observation,
      pipelines: [...observation.pipelines, { key: "flama-unknown-v1", enforceTransitions: true, archivedAt: null }],
    });
    expect(attestation.checks.lifecycles).toBe("drift");
  });

  it("writes create-only mode-0600 evidence outside the checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "flama-paperclip-attestation-"));
    const directory = join(root, "evidence");
    await mkdir(directory);
    const attestation = attestPaperclipGovernance(observation);
    await writePaperclipGovernanceAttestation(directory, attestation);
    const path = join(directory, `paperclip-governance-${observation.runId}.json`);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(attestation);
    await expect(writePaperclipGovernanceAttestation(directory, attestation)).rejects.toThrow();
  });
});
