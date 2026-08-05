import { describe, expect, it } from "vitest";
import { certifyPreflight, CertifyError, type CertifyInput } from "./certify.js";
import { preflightPayloadDigest } from "./publish-check.js";

const run = {
  schemaVersion: 1 as const,
  repository: "maxbec/example",
  headSha: "a".repeat(40),
  baseSha: "b".repeat(40),
  startedAt: "2026-08-01T10:00:00.000Z",
  finishedAt: "2026-08-01T10:00:10.000Z",
  runnerClass: "paperclip_ephemeral" as const,
  releaseImpact: "none" as const,
  status: "passed" as const,
  commands: [
    { command: "./scripts/delivery buildable", status: "passed", exitCode: 0,
      durationMilliseconds: 10, outputBytes: 1, evidenceDigest: `sha256:${"1".repeat(64)}` },
    { command: "./scripts/delivery affected", status: "passed", exitCode: 0,
      durationMilliseconds: 10, outputBytes: 1, evidenceDigest: `sha256:${"2".repeat(64)}` },
  ],
};

function input(): CertifyInput {
  return {
    run,
    controller: "maxbec-delivery-controller",
    appSlug: "flama-delivery-maxbec",
    runnerId: "local-1",
    signedAt: "2026-08-01T10:00:20.000Z",
  };
}

describe("preflight certification", () => {
  it("certifies a passing run and binds the signature to its exact payload", () => {
    const certified = certifyPreflight(input());

    expect(certified.signature).toMatchObject({
      algorithm: "github-app",
      issuer: "flama-delivery-maxbec",
      subject: "maxbec-delivery-controller",
    });
    // The digest must cover the run, so altering it invalidates the signature.
    expect(certified.signature.payloadDigest).toBe(preflightPayloadDigest(certified));
    // Run telemetry is not part of what is certified.
    for (const command of certified.commands) {
      expect(Object.keys(command).sort()).toEqual(
        ["command", "evidenceDigest", "exitCode", "status"],
      );
    }
    const tampered = { ...certified, headSha: "c".repeat(40) };
    expect(preflightPayloadDigest(tampered)).not.toBe(certified.signature.payloadDigest);
  });

  it("refuses to certify a run that did not pass", () => {
    const failed = {
      ...input(),
      run: { ...run, status: "failed" as const,
        commands: [{ ...run.commands[0]!, status: "failed", exitCode: 1 }, run.commands[1]!] },
    };

    expect(() => certifyPreflight(failed)).toThrow(
      expect.objectContaining<Partial<CertifyError>>({ code: "certify_run_not_passed" }),
    );
  });

  it("refuses a signing time before the run finished", () => {
    expect(() => certifyPreflight({ ...input(), signedAt: "2026-08-01T09:59:００.000Z" })).toThrow();
    expect(() => certifyPreflight({ ...input(), signedAt: "2026-08-01T10:00:05.000Z" })).toThrow(
      expect.objectContaining<Partial<CertifyError>>({ code: "certify_signed_before_finish" }),
    );
  });

  it("refuses a controller that does not own the repository owner", () => {
    expect(() => certifyPreflight({ ...input(), controller: "edilio-delivery-controller" })).toThrow(
      expect.objectContaining<Partial<CertifyError>>({ code: "certify_controller_mismatch" }),
    );
  });
});
