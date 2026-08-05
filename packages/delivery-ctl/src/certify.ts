import { preflightPayloadDigest, type SignedPreflightEvidence } from "./publish-check.js";

type Controller =
  | "maxbec-delivery-controller"
  | "navigaite-delivery-controller"
  | "edilio-delivery-controller";

const controllerByOwner: Readonly<Record<string, Controller>> = {
  maxbec: "maxbec-delivery-controller",
  navigaite: "navigaite-delivery-controller",
  "edilio-app": "edilio-delivery-controller",
};

export interface PreflightRun {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly runnerClass: "paperclip_ephemeral";
  readonly releaseImpact: "none" | "patch" | "minor" | "major";
  readonly status: "passed" | "failed";
  readonly commands: readonly {
    readonly command: string;
    readonly status: string;
    readonly exitCode: number;
    readonly durationMilliseconds: number;
    readonly outputBytes: number;
    readonly evidenceDigest: string;
  }[];
}

export interface CertifyInput {
  readonly run: PreflightRun;
  readonly controller: Controller;
  readonly appSlug: string;
  readonly runnerId: string;
  readonly signedAt: string;
}

export type CertifyErrorCode =
  | "certify_run_not_passed"
  | "certify_signed_before_finish"
  | "certify_controller_mismatch"
  | "certify_commands_invalid";

export class CertifyError extends Error {
  constructor(readonly code: CertifyErrorCode) {
    super("preflight certification refused");
    this.name = "CertifyError";
  }
}

/**
 * Attests that a preflight run was observed to pass. The attestation carries no
 * cryptography: its worth rests entirely on who is permitted to emit it, so the
 * refusals below are the whole safeguard. A failing run, a signature predating
 * the run, or a controller that does not own the repository is never certified.
 */
export function certifyPreflight(input: CertifyInput): SignedPreflightEvidence {
  const owner = input.run.repository.split("/")[0] ?? "";
  if (controllerByOwner[owner] !== input.controller) {
    throw new CertifyError("certify_controller_mismatch");
  }
  if (
    input.run.status !== "passed" ||
    input.run.commands.some(({ status, exitCode }) => status !== "passed" || exitCode !== 0)
  ) {
    throw new CertifyError("certify_run_not_passed");
  }
  if (
    input.run.commands.length !== 2 ||
    input.run.commands[0]?.command !== "./scripts/delivery buildable" ||
    input.run.commands[1]?.command !== "./scripts/delivery affected"
  ) {
    throw new CertifyError("certify_commands_invalid");
  }
  const finished = Date.parse(input.run.finishedAt);
  const signed = Date.parse(input.signedAt);
  if (!Number.isFinite(finished) || !Number.isFinite(signed) || signed < finished) {
    throw new CertifyError("certify_signed_before_finish");
  }

  const payload = {
    schemaVersion: input.run.schemaVersion,
    repository: input.run.repository,
    headSha: input.run.headSha,
    baseSha: input.run.baseSha,
    startedAt: input.run.startedAt,
    finishedAt: input.run.finishedAt,
    runner: {
      class: input.run.runnerClass,
      id: input.runnerId,
      controller: input.controller,
    },
    // The signed evidence carries only what the attestation is about. Timing and
    // output sizes are run telemetry and are not part of what is certified.
    commands: input.run.commands.map(({ command, status, exitCode, evidenceDigest }) => ({
      command,
      status,
      exitCode,
      evidenceDigest,
    })),
    releaseImpact: input.run.releaseImpact,
  } as unknown as SignedPreflightEvidence;

  return {
    ...payload,
    signature: {
      issuer: input.appSlug,
      subject: input.controller,
      algorithm: "github-app",
      payloadDigest: preflightPayloadDigest(payload),
      signedAt: input.signedAt,
    },
  } as SignedPreflightEvidence;
}
