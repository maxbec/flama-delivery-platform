import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { auditCanaries, planCanaries, type CanaryInput } from "./canary.js";

const audited = JSON.parse(
  await readFile(new URL("../../../tests/fixtures/canary/valid.json", import.meta.url), "utf8"),
) as CanaryInput;
const planned: CanaryInput = {
  ...audited,
  candidates: audited.candidates.map((candidate) => ({ ...candidate, evidence: null })),
};

describe("representative canary gates", () => {
  it("plans complete coverage without exposing candidate repositories or SHAs", () => {
    const result = planCanaries(planned);
    expect(result).toMatchObject({
      status: "planned",
      coverage: {
        fast: true,
        major: true,
        private: true,
        public: true,
        maxbec: true,
        navigaite: true,
        edilio: true,
        legacyStack: true,
        libraryRelease: true,
        dockerDeployment: true,
        managedPlatformDeployment: true,
      },
      proofs: {
        preflight: "planned",
        autoMerge: "planned",
        release: "planned",
        deploymentApproval: "planned",
        secretIsolation: "planned",
        infisicalOidc: "planned",
        infisicalSync: "planned",
        rollback: "planned",
        eventReplay: "planned",
        pooledCost: "planned",
      },
      findingCount: 0,
      findings: [],
    });
    const serialized = JSON.stringify(result);
    for (const candidate of planned.candidates) {
      expect(serialized).not.toContain(candidate.repository.nameWithOwner);
      expect(serialized).not.toContain(candidate.source.sha);
    }
  });

  it("passes only after every required proof and representative coverage is present", () => {
    const result = auditCanaries(audited);
    expect(result).toMatchObject({
      status: "passed",
      findingCount: 0,
      findings: [],
      proofs: {
        preflight: "passed",
        autoMerge: "passed",
        release: "passed",
        deploymentApproval: "passed",
        secretIsolation: "passed",
        infisicalOidc: "passed",
        infisicalSync: "passed",
        rollback: "passed",
        eventReplay: "passed",
        pooledCost: "passed",
      },
    });
    expect(result.planDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(result.evidenceDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    const serialized = JSON.stringify(result);
    for (const candidate of audited.candidates) {
      expect(serialized).not.toContain(candidate.repository.nameWithOwner);
      expect(serialized).not.toContain(candidate.source.sha);
      expect(serialized).not.toContain(candidate.evidence?.evidenceDigest);
    }
  });

  it("rejects incomplete coverage and evidence attached to a plan", () => {
    const incomplete: CanaryInput = {
      ...planned,
      candidates: planned.candidates.filter(({ repository }) => repository.owner !== "edilio"),
    };
    expect(planCanaries(incomplete)).toMatchObject({
      status: "failed",
      findings: expect.arrayContaining([{ code: "canary_coverage_incomplete", location: "coverage" }]),
    });
    expect(planCanaries(audited)).toMatchObject({
      status: "failed",
      findings: expect.arrayContaining([{ code: "canary_plan_contains_evidence", location: "evidence" }]),
    });
  });

  it("rejects stale source binding and failed release/deployment proofs", () => {
    const first = audited.candidates[0]!;
    const second = audited.candidates[1]!;
    if (first.evidence === null || second.evidence === null) throw new Error("invalid test fixture");
    const drifted: CanaryInput = {
      ...audited,
      candidates: [
        {
          ...first,
          evidence: {
            ...first.evidence,
            sourceSha: "ffffffffffffffffffffffffffffffffffffffff",
            proofs: { ...first.evidence.proofs, rollback: "failed" },
          },
        },
        {
          ...second,
          evidence: { ...second.evidence, proofs: { ...second.evidence.proofs, release: "failed" } },
        },
        ...audited.candidates.slice(2),
      ],
    };
    expect(auditCanaries(drifted)).toMatchObject({
      status: "failed",
      findings: expect.arrayContaining([
        { code: "canary_evidence_invalid", location: "evidence" },
        { code: "deployment_proof_failed", location: "evidence" },
        { code: "library_release_proof_failed", location: "evidence" },
      ]),
    });
  });

  it("rejects duplicate repositories and profile/source-branch drift", () => {
    const first = planned.candidates[0]!;
    const second = planned.candidates[1]!;
    const drifted: CanaryInput = {
      ...planned,
      candidates: [
        first,
        {
          ...second,
          repository: { ...second.repository, nameWithOwner: first.repository.nameWithOwner },
          source: { ...second.source, branch: "main" },
        },
        ...planned.candidates.slice(2),
      ],
    };
    expect(planCanaries(drifted)).toMatchObject({
      status: "failed",
      findings: expect.arrayContaining([
        { code: "candidate_repository_duplicate", location: "candidate" },
        { code: "candidate_scope_invalid", location: "candidate" },
      ]),
    });
  });
});
