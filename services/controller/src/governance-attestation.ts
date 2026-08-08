import { lstat, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import {
  createPaperclipGovernanceAttestation,
  type PaperclipDeliveryControllerName,
  type PaperclipGovernanceAttestation,
} from "../../../packages/contracts/src/paperclip-governance-attestation.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const managedPipelineKeys = new Set([
  "flama-project-bootstrap-v1",
  "flama-feature-fix-v1",
  "flama-release-deployment-v1",
]);

interface CompanyObservation {
  readonly id: string;
  readonly name: string;
  readonly status?: string;
}

interface ControllerObservation {
  readonly id: string;
  readonly companyId: string;
  readonly name: string;
  readonly role: string;
  readonly adapterType: string;
  readonly budgetMonthlyCents: number;
  readonly status?: string;
  readonly desiredSkills?: readonly unknown[];
  readonly permissions?: Readonly<Record<string, unknown>> | null;
  readonly metadata?: Readonly<Record<string, unknown>> | null;
}

interface PipelineObservation {
  readonly key: string;
  readonly enforceTransitions: boolean;
  readonly archivedAt: string | null;
}

export interface PaperclipGovernanceObservation {
  readonly companyId: string;
  readonly controllerId: string;
  readonly controllerName: PaperclipDeliveryControllerName;
  readonly runId: string;
  readonly observedAt: string;
  readonly company: CompanyObservation;
  readonly controller: ControllerObservation;
  readonly pipelines: readonly PipelineObservation[];
}

export class GovernanceAttestationError extends Error {
  constructor() {
    super("Paperclip governance attestation rejected");
    this.name = "GovernanceAttestationError";
  }
}

function validDateTime(value: string): boolean {
  const timestamp = Date.parse(value);
  return value.length <= 64 && Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

const deliverySkillName = "flama-paperclip-delivery";

/**
 * `desiredSkills` carries Paperclip skill *keys*, and a key is namespaced —
 * `owner/repo/name`. The provisioner looks the skill up by *name* in the
 * company library and assigns whatever key that lookup returns
 * (`paperclip-controllers.ts`), so comparing the assigned list against the bare
 * name never matched. The name is the final segment of the key.
 *
 * The check still has to be an equality on that segment rather than a
 * substring test: `…/flama-paperclip-delivery-draft` must not satisfy it.
 */
function holdsDeliverySkill(desiredSkills: readonly unknown[] | undefined): boolean {
  return (desiredSkills ?? []).some(
    (key) =>
      typeof key === "string" && (key === deliverySkillName || key.endsWith(`/${deliverySkillName}`)),
  );
}

function controllerCompliant(observation: PaperclipGovernanceObservation): boolean {
  const controller = observation.controller;
  const permissions = controller.permissions ?? {};
  const metadata = controller.metadata ?? {};
  return controller.id === observation.controllerId && controller.companyId === observation.companyId &&
    controller.name === observation.controllerName && controller.role === "devops" &&
    controller.adapterType === "process" && controller.budgetMonthlyCents === 0 &&
    ["idle", "running", "paused"].includes(controller.status ?? "") &&
    holdsDeliverySkill(controller.desiredSkills) &&
    permissions["canCreateAgents"] === false && permissions["canCreateSkills"] === false &&
    permissions["canAssignTasks"] === false && metadata["managedBy"] === "flama-delivery-platform" &&
    // The provisioner is the authority on the topology it writes, and it has
    // provisioned version 2 since the controller topology migration
    // (`paperclip-controllers.ts`). This assertion was left on 1 and so could
    // not hold against any controller the current provisioner produces.
    metadata["topologyVersion"] === 2;
}

function lifecyclesCompliant(pipelines: readonly PipelineObservation[]): boolean {
  const managed = pipelines.filter(({ key }) => key.startsWith("flama-"));
  return managed.length === managedPipelineKeys.size && [...managedPipelineKeys].every((key) => {
    const matching = managed.filter((pipeline) => pipeline.key === key);
    return matching.length === 1 && matching[0]?.enforceTransitions === true && matching[0]?.archivedAt === null;
  });
}

export function attestPaperclipGovernance(
  observation: PaperclipGovernanceObservation,
): PaperclipGovernanceAttestation {
  if (
    !uuidPattern.test(observation.companyId) || !uuidPattern.test(observation.controllerId) ||
    !uuidPattern.test(observation.runId) || !validDateTime(observation.observedAt)
  ) throw new GovernanceAttestationError();

  const expectedCompany = observation.controllerName === "maxbec-delivery-controller"
    ? "Private"
    : observation.controllerName === "navigaite-delivery-controller"
      ? "// Navigaite"
      : "Edilio";
  return createPaperclipGovernanceAttestation({
    source: "paperclip-company-controller",
    company: expectedCompany,
    controller: observation.controllerName,
    runId: observation.runId,
    observedAt: observation.observedAt,
    checks: {
      company: observation.company.id === observation.companyId && observation.company.name === expectedCompany &&
        observation.company.status !== "archived" ? "compliant" : "drift",
      controller: controllerCompliant(observation) ? "compliant" : "drift",
      lifecycles: lifecyclesCompliant(observation.pipelines) ? "compliant" : "drift",
    },
  });
}

export async function writePaperclipGovernanceAttestation(
  directory: string | undefined,
  attestation: PaperclipGovernanceAttestation,
): Promise<void> {
  if (
    directory === undefined || directory.length === 0 || directory.length > 4_096 ||
    /[\r\n\u0000]/u.test(directory) || !isAbsolute(directory) || normalize(directory) !== directory
  ) throw new GovernanceAttestationError();
  try {
    const [metadata, canonical] = await Promise.all([lstat(directory), realpath(directory)]);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || canonical !== directory) throw new Error("unsafe");
    await writeFile(
      join(directory, `paperclip-governance-${attestation.runId}.json`),
      `${JSON.stringify(attestation, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  } catch {
    throw new GovernanceAttestationError();
  }
}
