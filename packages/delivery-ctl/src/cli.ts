import { randomInt } from "node:crypto";
import { lstat, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";
import { orchestrateDeployment, type DeploymentManifest, type ProviderName } from "../../../providers/src/orchestrator.js";
import {
  executeRollback,
  planRollback,
  RollbackError,
  type RollbackInput,
} from "../../../providers/src/rollback.js";
import {
  loadDeploymentAdapter,
  RepositoryVerificationRunner,
  SystemCommandRunner,
  SystemDeploymentClock,
} from "../../../providers/src/runtime.js";
import {
  AdapterUnavailableError,
  createBuiltinAdapter,
} from "../../../providers/src/adapters/registry.js";
import { createSchemaValidator, type SchemaName } from "../../contracts/src/schema-validator.js";
import { classifyInventory, type ClassificationInput } from "./classify.js";
import { auditDeploymentPullRequest, type DeploymentPullRequestInput } from "./deployment-pr.js";
import { certifyPreflight, CertifyError, type CertifyInput } from "./certify.js";
import { RenderConflictError, renderTemplates, type RenderInput } from "./render.js";
import { auditSecrets, type SecretsAuditInput } from "./secrets-audit.js";
import { auditCanaries, planCanaries, type CanaryInput } from "./canary.js";
import {
  auditGitHubPolicy,
  type BranchProfilesPolicy,
  type GitHubPolicyAuditInput,
} from "./github-policy-audit.js";
import { PreflightError, runPreflight, type PreflightRunInput } from "./preflight.js";
import {
  complianceView,
  GovernanceViewError,
  usageView,
  type CiBudgetPolicy,
  type GovernanceResultInput,
} from "./governance-views.js";
import {
  GitHubPolicyRepairError,
  planGitHubPolicyRepair,
  type GitHubPolicyRepairInput,
} from "./github-policy-repair.js";
import {
  decideFailureResponse,
  FailurePolicyError,
  type FailureObservation,
} from "./failure-policy.js";
import { auditInventory, InventoryAuditError, type InventoryAuditInput } from "./inventory.js";
import {
  bootstrapRepository,
  BootstrapError,
  type BootstrapInput,
} from "./bootstrap.js";
import {
  GitHubRestCheckClient,
  planPublishCheck,
  publishCheck,
  PublishCheckError,
  type PublishCheckInput,
} from "./publish-check.js";
import {
  GitHubRestPromotionClient,
  planPromotion,
  promote,
  PromotionError,
  type PromotionInput,
} from "./promote.js";
import {
  auditReleaseEvidence,
  GitHubCliReleaseVerifier,
  planReleaseEvidence,
  ReleaseEvidenceError,
  type ReleaseEvidenceInput,
} from "./release-evidence.js";
import {
  applyPaperclipFoundation,
  type LifecycleContract,
  PaperclipFoundationError,
  type PaperclipFoundationInput,
  PaperclipRestFoundationClient,
  planPaperclipFoundation,
} from "./paperclip-foundation.js";
import {
  applyPaperclipControllers,
  controllerRuntimeEntry,
  type ControllerContract,
  PaperclipControllersError,
  type PaperclipControllersInput,
  PaperclipRestControllersClient,
  planPaperclipControllers,
} from "./paperclip-controllers.js";
import {
  applyPaperclipBinding,
  PaperclipBindingsError,
  type PaperclipBindingInput,
  PaperclipRestBindingsClient,
  planPaperclipBinding,
  PostgresRepositoryBindingStore,
} from "./paperclip-bindings.js";
import {
  applyPaperclipTransitionAuthorization,
  PaperclipTransitionAuthorizationError,
  type PaperclipTransitionAuthorizationInput,
  planPaperclipTransitionAuthorization,
  PostgresTransitionAuthorizationWriter,
} from "./paperclip-transition-authorization.js";
import {
  applyPaperclipRoutines,
  type PaperclipRoutineContract,
  PaperclipRestRoutinesClient,
  PaperclipRoutinesError,
  type PaperclipRoutinesInput,
  planPaperclipRoutines,
} from "./paperclip-routines.js";
import {
  applyPaperclipGithubTransitionRoutine,
  InfisicalRestRoutineSecretStore,
  type PaperclipGithubTransitionRoutineContract,
  PaperclipGithubTransitionRoutineError,
  type PaperclipGithubTransitionRoutineInput,
  planPaperclipGithubTransitionRoutine,
} from "./paperclip-github-transition-routine.js";
import {
  auditReconciliation,
  createReconciliationRuntime,
  planReconciliation,
  ReconciliationError,
  type ReconciliationInput,
} from "./reconcile.js";

const toolVersion = "0.1.0";
const maximumInputBytes = 10 * 1024 * 1024;

export interface CliIo {
  writeStdout(value: string): void;
  writeStderr(value: string): void;
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function fail(io: CliIo, code: string): number {
  io.writeStderr(jsonLine({ error: { code }, ok: false, toolVersion }));
  return 2;
}

async function readStructuredInput(path: string, format: "json" | "yaml"): Promise<unknown> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > maximumInputBytes) {
    throw new Error("input rejected");
  }
  const source = await readFile(path, "utf8");
  return format === "json"
    ? JSON.parse(source)
    : parseYaml(source, { maxAliasCount: 0, prettyErrors: false, strict: true });
}

function isSchemaName(value: string | undefined): value is SchemaName {
  return [
    "bootstrap-input",
    "bootstrap-result",
    "canary-input",
    "canary-result",
    "delivery-contract",
    "deployment-manifest",
    "deployment-pr-input",
    "deployment-result",
    "inventory-audit-result",
    "governance-input",
    "governance-result",
    "failure-observation",
    "failure-decision",
    "github-policy-audit-input",
    "github-policy-repair-input",
    "github-policy-repair-plan",
    "github-policy-audit-result",
    "preflight-evidence",
    "preflight-run-input",
    "preflight-run-result",
    "publish-check-input",
    "publish-check-result",
    "promotion-input",
    "promotion-result",
    "release-evidence-input",
    "release-evidence-result",
    "reconciliation-evidence",
    "reconciliation-input",
    "reconciliation-result",
    "platform-release-manifest",
    "paperclip-controller",
    "paperclip-binding-input",
    "paperclip-binding-result",
    "github-policy-posture",
    "paperclip-controllers-input",
    "paperclip-controllers-result",
    "paperclip-foundation-input",
    "paperclip-foundation-result",
    "paperclip-github-transition-routine",
    "paperclip-github-transition-routine-input",
    "paperclip-github-transition-routine-result",
    "paperclip-transition-authorization-input",
    "paperclip-transition-authorization-result",
    "paperclip-lifecycle",
    "paperclip-routine",
    "paperclip-routines-input",
    "paperclip-routines-result",
    "paperclip-topology",
    "repository-inventory",
    "repository-scope-policy",
    "render-input",
    "secret-exceptions",
    "secrets-audit-input",
  ].includes(value ?? "");
}

function classificationInput(value: unknown): ClassificationInput {
  if (typeof value !== "object" || value === null) throw new Error("invalid inventory");
  const repositories = Reflect.get(value, "repositories");
  if (!Array.isArray(repositories)) throw new Error("invalid inventory");
  return { repositories } as ClassificationInput;
}

function secretsAuditInput(value: unknown): SecretsAuditInput {
  return value as SecretsAuditInput;
}

interface FullDeploymentManifest {
  readonly version: string;
  readonly artifact: { readonly uri: string; readonly digest: string };
  readonly previousArtifact: { readonly uri: string; readonly digest: string } | null;
  readonly provider: {
    readonly name: ProviderName;
    readonly parameters?: Readonly<Record<string, string>>;
  };
  readonly verification: { readonly expectedVersion: string; readonly soakSeconds: number };
  readonly rollback: { readonly automatic: boolean; readonly attemptLimit: number };
}

function deploymentManifest(value: unknown): FullDeploymentManifest {
  return value as FullDeploymentManifest;
}

/**
 * A repository-supplied adapter path stays authoritative when given, which is how
 * the `custom` provider works. Otherwise the platform's builtin adapter for that
 * provider is used, so consumers never copy shared deployment logic. An
 * unimplemented provider fails closed instead of falling back.
 */
async function selectAdapter(
  workingDirectory: string,
  adapterPath: string | undefined,
  provider: FullDeploymentManifest["provider"],
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  if (typeof adapterPath === "string") {
    return loadDeploymentAdapter(workingDirectory, adapterPath, provider.name);
  }
  // A provider credential is injected from the process environment, where
  // `infisical run` places it. It is never read from the manifest and never
  // reaches an argument list.
  const vercelToken = environment["VERCEL_TOKEN"];
  const digitalOceanToken = environment["DIGITALOCEAN_ACCESS_TOKEN"];
  return createBuiltinAdapter(
    provider.name,
    provider.parameters ?? {},
    new SystemCommandRunner(workingDirectory),
    undefined,
    {
      ...(vercelToken === undefined || vercelToken.length === 0
        ? {}
        : { vercelCredential: { reveal: () => vercelToken } }),
      ...(digitalOceanToken === undefined || digitalOceanToken.length === 0
        ? {}
        : { digitalOceanCredential: { reveal: () => digitalOceanToken } }),
    },
  );
}

async function writeEvidence(path: string, value: unknown): Promise<void> {
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("unsafe evidence directory");
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

async function readLifecycleContracts(repositoryRoot: string): Promise<readonly LifecycleContract[]> {
  return Promise.all(
    ["project-bootstrap", "feature-fix", "release-deployment"].map(async (name) =>
      JSON.parse(
        await readFile(join(repositoryRoot, "lifecycles", `${name}.json`), "utf8"),
      ) as LifecycleContract,
    ),
  );
}

export async function runCli(
  argv: readonly string[],
  io: CliIo,
  repositoryRoot: string,
  workingDirectory = process.cwd(),
): Promise<number> {
  const command = argv[0];
  if (command === "--version" || command === "version") {
    io.writeStdout(jsonLine({ toolVersion }));
    return 0;
  }
  if (
    command !== "validate" &&
    command !== "bootstrap" &&
    command !== "canary-audit" &&
    command !== "canary-plan" &&
    command !== "inventory" &&
    command !== "paperclip-foundation" &&
    command !== "paperclip-bindings" &&
    command !== "paperclip-controllers" &&
    command !== "paperclip-routines" &&
    command !== "paperclip-github-transition-routine" &&
    command !== "paperclip-transition-authorize" &&
    command !== "classify" &&
    command !== "deployment-pr" &&
    command !== "deploy" &&
    command !== "preflight" &&
    command !== "certify" &&
    command !== "publish-check" &&
    command !== "promote" &&
    command !== "release-evidence" &&
    command !== "reconcile" &&
    command !== "rollback" &&
    command !== "failure-policy" &&
    command !== "github-policy-repair" &&
    command !== "compliance" &&
    command !== "usage" &&
    command !== "github-policy-audit" &&
    command !== "secrets-audit" &&
    command !== "render"
  ) {
    return fail(io, "unsupported_command");
  }

  let options: {
    readonly input?: string;
    readonly adapter?: string;
    readonly format?: string;
    readonly output?: string;
    readonly schema?: string;
    readonly "dry-run": boolean;
  };
  try {
    const parsed = parseArgs({
      args: [...argv.slice(1)],
      options: {
        input: { type: "string" },
        adapter: { type: "string" },
        format: { type: "string", default: "json" },
        output: { type: "string" },
        schema: { type: "string" },
        "dry-run": { type: "boolean", default: false },
      },
      allowPositionals: false,
      strict: true,
    });
    options = parsed.values;
  } catch {
    return fail(io, "invalid_arguments");
  }
  const inputPath = options.input;
  if (typeof inputPath !== "string") return fail(io, "input_required");
  if (options.format !== "json" && options.format !== "yaml") return fail(io, "invalid_format");

  try {
    const input = await readStructuredInput(inputPath, options.format);
    const validator = await createSchemaValidator(repositoryRoot);
    if (command === "validate") {
      if (!isSchemaName(options.schema)) return fail(io, "schema_required");
      const validation = validator.validate(options.schema, input);
      io.writeStdout(
        jsonLine({
          command,
          dryRun: options["dry-run"] ?? false,
          ok: validation.ok,
          schema: validation.schema,
          toolVersion,
          ...(validation.ok ? {} : { errors: validation.errors }),
        }),
      );
      return validation.ok ? 0 : 1;
    }

    if (command === "bootstrap") {
      if (typeof options.output !== "string") return fail(io, "output_required");
      const validation = validator.validate("bootstrap-input", input);
      if (!validation.ok) {
        io.writeStdout(jsonLine({ command, ok: false, errors: validation.errors, toolVersion }));
        return 1;
      }
      const bootstrapInput = input as BootstrapInput;
      const contractValidation = validator.validate("delivery-contract", bootstrapInput.contract);
      const renderValidation = validator.validate("render-input", bootstrapInput.render);
      if (!contractValidation.ok || !renderValidation.ok) {
        io.writeStdout(
          jsonLine({
            command,
            ok: false,
            errors: [
              ...(contractValidation.ok ? [] : contractValidation.errors),
              ...(renderValidation.ok ? [] : renderValidation.errors),
            ],
            toolVersion,
          }),
        );
        return 1;
      }
      const result = await bootstrapRepository({
        repositoryRoot,
        outputRoot: options.output,
        input: bootstrapInput,
        dryRun: options["dry-run"],
      });
      const resultValidation = validator.validate("bootstrap-result", result);
      if (!resultValidation.ok) return fail(io, "result_validation_failed");
      io.writeStdout(jsonLine({ command, dryRun: options["dry-run"], ok: true, toolVersion, result }));
      return 0;
    }

    if (command === "classify") {
      const validation = validator.validate("repository-inventory", input);
      if (!validation.ok) {
        io.writeStdout(jsonLine({ command, ok: false, errors: validation.errors, toolVersion }));
        return 1;
      }
      io.writeStdout(
        jsonLine({ command, dryRun: options["dry-run"] ?? false, ok: true, toolVersion, result: classifyInventory(classificationInput(input)) }),
      );
      return 0;
    }

    if (command === "inventory") {
      const validation = validator.validate("repository-inventory", input);
      if (!validation.ok) {
        io.writeStdout(jsonLine({ command, ok: false, errors: validation.errors, toolVersion }));
        return 1;
      }
      const result = auditInventory(input as InventoryAuditInput);
      const resultValidation = validator.validate("inventory-audit-result", result);
      if (!resultValidation.ok) return fail(io, "result_validation_failed");
      io.writeStdout(jsonLine({ command, dryRun: options["dry-run"], ok: true, toolVersion, result }));
      return 0;
    }

    if (command === "paperclip-foundation") {
      const validation = validator.validate("paperclip-foundation-input", input);
      if (!validation.ok) {
        io.writeStdout(jsonLine({ command, ok: false, errors: validation.errors, toolVersion }));
        return 1;
      }
      const lifecycleContracts = await readLifecycleContracts(repositoryRoot);
      for (const contract of lifecycleContracts) {
        const lifecycleValidation = validator.validate("paperclip-lifecycle", contract);
        if (!lifecycleValidation.ok) {
          return fail(io, "paperclip_contract_invalid");
        }
      }
      const foundationInput = input as PaperclipFoundationInput;
      const outputPath = options.output;
      if (!options["dry-run"] && typeof outputPath !== "string") {
        return fail(io, "output_required");
      }
      const result = options["dry-run"]
        ? planPaperclipFoundation(foundationInput, lifecycleContracts)
        : await applyPaperclipFoundation(
            foundationInput,
            lifecycleContracts,
            new PaperclipRestFoundationClient(process.env),
          );
      const resultValidation = validator.validate("paperclip-foundation-result", result);
      if (!resultValidation.ok) return fail(io, "result_validation_failed");
      if (!options["dry-run"]) {
        if (typeof outputPath !== "string") return fail(io, "output_required");
        await writeEvidence(outputPath, result);
      }
      io.writeStdout(jsonLine({ command, dryRun: options["dry-run"], ok: true, toolVersion, result }));
      return 0;
    }

    if (command === "paperclip-bindings") {
      const validation = validator.validate("paperclip-binding-input", input);
      if (!validation.ok) {
        io.writeStdout(jsonLine({ command, ok: false, errors: validation.errors, toolVersion }));
        return 1;
      }
      const bindingInput = input as PaperclipBindingInput;
      if (!options["dry-run"] && typeof options.output !== "string") return fail(io, "output_required");
      let result;
      if (options["dry-run"]) {
        result = planPaperclipBinding(bindingInput);
      } else {
        const store = new PostgresRepositoryBindingStore(process.env);
        try {
          result = await applyPaperclipBinding(
            bindingInput,
            new PaperclipRestBindingsClient(process.env),
            store,
          );
        } finally {
          await store.close();
        }
      }
      const resultValidation = validator.validate("paperclip-binding-result", result);
      if (!resultValidation.ok) return fail(io, "result_validation_failed");
      if (!options["dry-run"]) {
        if (typeof options.output !== "string") return fail(io, "output_required");
        await writeEvidence(options.output, result);
      }
      io.writeStdout(jsonLine({ command, dryRun: options["dry-run"], ok: true, toolVersion, result }));
      return 0;
    }

    if (command === "paperclip-controllers") {
      const validation = validator.validate("paperclip-controllers-input", input);
      if (!validation.ok) {
        io.writeStdout(jsonLine({ command, ok: false, errors: validation.errors, toolVersion }));
        return 1;
      }
      const controllersInput = input as PaperclipControllersInput;
      const contract = JSON.parse(await readFile(
        join(repositoryRoot, "lifecycles", "controllers", `${controllersInput.controller}.json`),
        "utf8",
      )) as ControllerContract;
      const contractValidation = validator.validate("paperclip-controller", contract);
      if (!contractValidation.ok) return fail(io, "paperclip_contract_invalid");
      if (!options["dry-run"] && typeof options.output !== "string") return fail(io, "output_required");
      if (!options["dry-run"]) {
        const entry = await stat(controllerRuntimeEntry(controllersInput.runtimeRoot));
        if (!entry.isFile()) return fail(io, "controller_runtime_unavailable");
      }
      const result = options["dry-run"]
        ? planPaperclipControllers(controllersInput, contract)
        : await applyPaperclipControllers(controllersInput, contract, new PaperclipRestControllersClient(process.env));
      const resultValidation = validator.validate("paperclip-controllers-result", result);
      if (!resultValidation.ok) return fail(io, "result_validation_failed");
      if (!options["dry-run"]) {
        if (typeof options.output !== "string") return fail(io, "output_required");
        await writeEvidence(options.output, result);
      }
      io.writeStdout(jsonLine({ command, dryRun: options["dry-run"], ok: true, toolVersion, result }));
      return 0;
    }

    if (command === "paperclip-transition-authorize") {
      const validation = validator.validate("paperclip-transition-authorization-input", input);
      if (!validation.ok) {
        io.writeStdout(jsonLine({ command, ok: false, errors: validation.errors, toolVersion }));
        return 1;
      }
      const authorizationInput = input as PaperclipTransitionAuthorizationInput;
      if (!options["dry-run"] && typeof options.output !== "string") return fail(io, "output_required");
      let result;
      if (options["dry-run"]) {
        result = planPaperclipTransitionAuthorization(authorizationInput);
      } else {
        const writer = new PostgresTransitionAuthorizationWriter(process.env);
        try {
          result = await applyPaperclipTransitionAuthorization(authorizationInput, writer);
        } finally {
          await writer.close();
        }
      }
      const resultValidation = validator.validate("paperclip-transition-authorization-result", result);
      if (!resultValidation.ok) return fail(io, "result_validation_failed");
      if (!options["dry-run"]) {
        if (typeof options.output !== "string") return fail(io, "output_required");
        await writeEvidence(options.output, result);
      }
      io.writeStdout(jsonLine({ command, dryRun: options["dry-run"], ok: true, toolVersion, result }));
      return 0;
    }

    if (command === "paperclip-routines") {
      const validation = validator.validate("paperclip-routines-input", input);
      if (!validation.ok) {
        io.writeStdout(jsonLine({ command, ok: false, errors: validation.errors, toolVersion }));
        return 1;
      }
      const contract = JSON.parse(await readFile(
        join(repositoryRoot, "routines", "nightly-reconciliation.json"),
        "utf8",
      )) as PaperclipRoutineContract;
      const contractValidation = validator.validate("paperclip-routine", contract);
      if (!contractValidation.ok) return fail(io, "paperclip_contract_invalid");
      const routinesInput = input as PaperclipRoutinesInput;
      if (!options["dry-run"] && typeof options.output !== "string") return fail(io, "output_required");
      const result = options["dry-run"]
        ? planPaperclipRoutines(routinesInput, contract)
        : await applyPaperclipRoutines(routinesInput, contract, new PaperclipRestRoutinesClient(process.env));
      const resultValidation = validator.validate("paperclip-routines-result", result);
      if (!resultValidation.ok) return fail(io, "result_validation_failed");
      if (!options["dry-run"]) {
        if (typeof options.output !== "string") return fail(io, "output_required");
        await writeEvidence(options.output, result);
      }
      io.writeStdout(jsonLine({ command, dryRun: options["dry-run"], ok: true, toolVersion, result }));
      return 0;
    }

    if (command === "paperclip-github-transition-routine") {
      const validation = validator.validate("paperclip-github-transition-routine-input", input);
      if (!validation.ok) {
        io.writeStdout(jsonLine({ command, ok: false, errors: validation.errors, toolVersion }));
        return 1;
      }
      const contract = JSON.parse(await readFile(
        join(repositoryRoot, "routines", "github-transition.json"),
        "utf8",
      )) as PaperclipGithubTransitionRoutineContract;
      const contractValidation = validator.validate("paperclip-github-transition-routine", contract);
      if (!contractValidation.ok) return fail(io, "paperclip_contract_invalid");
      const routineInput = input as PaperclipGithubTransitionRoutineInput;
      if (!options["dry-run"] && typeof options.output !== "string") return fail(io, "output_required");
      const result = options["dry-run"]
        ? planPaperclipGithubTransitionRoutine(routineInput, contract)
        : await applyPaperclipGithubTransitionRoutine(
            routineInput,
            contract,
            new PaperclipRestRoutinesClient(process.env),
            new InfisicalRestRoutineSecretStore(process.env),
          );
      const resultValidation = validator.validate("paperclip-github-transition-routine-result", result);
      if (!resultValidation.ok) return fail(io, "result_validation_failed");
      if (!options["dry-run"]) {
        if (typeof options.output !== "string") return fail(io, "output_required");
        await writeEvidence(options.output, result);
      }
      io.writeStdout(jsonLine({ command, dryRun: options["dry-run"], ok: true, toolVersion, result }));
      return 0;
    }

    if (command === "reconcile") {
      const validation = validator.validate("reconciliation-input", input);
      if (!validation.ok) {
        io.writeStdout(jsonLine({ command, ok: false, errors: validation.errors, toolVersion }));
        return 1;
      }
      const reconciliationInput = input as ReconciliationInput;
      if (!options["dry-run"] && typeof options.output !== "string") return fail(io, "output_required");
      if (options["dry-run"]) {
        const result = planReconciliation(reconciliationInput);
        const resultValidation = validator.validate("reconciliation-result", result);
        if (!resultValidation.ok) return fail(io, "result_validation_failed");
        io.writeStdout(jsonLine({ command, dryRun: true, ok: true, toolVersion, result }));
        return 0;
      }
      const runtime = createReconciliationRuntime(process.env);
      let audit;
      try {
        audit = await auditReconciliation(reconciliationInput, runtime);
      } finally {
        await runtime.close();
      }
      const resultValidation = validator.validate("reconciliation-result", audit.result);
      const evidenceValidation = validator.validate("reconciliation-evidence", audit.evidence);
      if (!resultValidation.ok || !evidenceValidation.ok) return fail(io, "result_validation_failed");
      if (typeof options.output !== "string") return fail(io, "output_required");
      await writeEvidence(options.output, audit.evidence);
      io.writeStdout(jsonLine({
        command,
        dryRun: false,
        ok: audit.result.status === "compliant",
        toolVersion,
        result: audit.result,
      }));
      return audit.result.status === "compliant" ? 0 : 1;
    }

    if (command === "certify") {
      if (typeof options.output !== "string") return fail(io, "output_required");
      const certifyInput = input as unknown as CertifyInput;
      const certified = certifyPreflight(certifyInput);
      const certifiedValidation = validator.validate("preflight-evidence", certified);
      if (!certifiedValidation.ok) return fail(io, "result_validation_failed");
      await writeEvidence(options.output, certified);
      io.writeStdout(jsonLine({ command, dryRun: false, ok: true, toolVersion,
        result: { schemaVersion: 1, status: "certified",
          headSha: certified.headSha, controller: certified.signature.subject } }));
      return 0;
    }

    if (command === "publish-check") {
      const validation = validator.validate("publish-check-input", input);
      if (!validation.ok) {
        io.writeStdout(jsonLine({ command, ok: false, errors: validation.errors, toolVersion }));
        return 1;
      }
      const publishInput = input as PublishCheckInput;
      const evidenceValidation = validator.validate("preflight-evidence", publishInput.evidence);
      if (!evidenceValidation.ok) {
        io.writeStdout(jsonLine({ command, ok: false, errors: evidenceValidation.errors, toolVersion }));
        return 1;
      }
      const result = options["dry-run"]
        ? planPublishCheck(publishInput)
        : await publishCheck(publishInput, new GitHubRestCheckClient(process.env));
      const resultValidation = validator.validate("publish-check-result", result);
      if (!resultValidation.ok) return fail(io, "result_validation_failed");
      if (!options["dry-run"] && typeof options.output === "string") {
        await writeEvidence(options.output, result);
      }
      io.writeStdout(jsonLine({ command, dryRun: options["dry-run"], ok: true, toolVersion, result }));
      return 0;
    }

    if (command === "promote") {
      const validation = validator.validate("promotion-input", input);
      if (!validation.ok) {
        io.writeStdout(jsonLine({ command, ok: false, errors: validation.errors, toolVersion }));
        return 1;
      }
      const promotionInput = input as PromotionInput;
      const outputPath = options.output;
      if (!options["dry-run"] && typeof outputPath !== "string") {
        return fail(io, "output_required");
      }
      const result = options["dry-run"]
        ? planPromotion(promotionInput)
        : await promote(promotionInput, new GitHubRestPromotionClient(process.env));
      const resultValidation = validator.validate("promotion-result", result);
      if (!resultValidation.ok) return fail(io, "result_validation_failed");
      if (!options["dry-run"]) {
        if (typeof outputPath !== "string") return fail(io, "output_required");
        await writeEvidence(outputPath, result);
      }
      io.writeStdout(jsonLine({ command, dryRun: options["dry-run"], ok: true, toolVersion, result }));
      return 0;
    }

    if (command === "render") {
      if (typeof options.output !== "string") return fail(io, "output_required");
      const validation = validator.validate("render-input", input);
      if (!validation.ok) {
        io.writeStdout(jsonLine({ command, ok: false, errors: validation.errors, toolVersion }));
        return 1;
      }
      if (!options["dry-run"]) return fail(io, "bootstrap_required");
      const result = await renderTemplates({
        repositoryRoot,
        outputRoot: options.output,
        input: input as RenderInput,
        dryRun: true,
      });
      io.writeStdout(jsonLine({ command, dryRun: options["dry-run"], ok: true, toolVersion, result }));
      return 0;
    }

    if (command === "release-evidence") {
      const validation = validator.validate("release-evidence-input", input);
      if (!validation.ok) {
        io.writeStdout(jsonLine({ command, ok: false, errors: validation.errors, toolVersion }));
        return 1;
      }
      const releaseInput = input as ReleaseEvidenceInput;
      const outputPath = options.output;
      if (!options["dry-run"] && typeof outputPath !== "string") {
        return fail(io, "output_required");
      }
      const result = options["dry-run"]
        ? planReleaseEvidence(releaseInput)
        : await auditReleaseEvidence(
            releaseInput,
            workingDirectory,
            new GitHubCliReleaseVerifier(process.env),
          );
      const resultValidation = validator.validate("release-evidence-result", result);
      if (!resultValidation.ok) return fail(io, "result_validation_failed");
      if (!options["dry-run"]) {
        if (typeof outputPath !== "string") return fail(io, "output_required");
        await writeEvidence(outputPath, result);
      }
      io.writeStdout(jsonLine({ command, dryRun: options["dry-run"], ok: true, toolVersion, result }));
      return 0;
    }

    if (command === "deployment-pr") {
      const validation = validator.validate("deployment-pr-input", input);
      if (!validation.ok) {
        io.writeStdout(jsonLine({ command, ok: false, errors: validation.errors, toolVersion }));
        return 1;
      }
      const result = auditDeploymentPullRequest(input as DeploymentPullRequestInput);
      io.writeStdout(
        jsonLine({
          command,
          dryRun: options["dry-run"],
          ok: result.status === "passed",
          toolVersion,
          result,
        }),
      );
      return result.status === "passed" ? 0 : 1;
    }

    if (command === "deploy") {
      const validation = validator.validate("deployment-manifest", input);
      if (!validation.ok) {
        io.writeStdout(jsonLine({ command, ok: false, errors: validation.errors, toolVersion }));
        return 1;
      }
      const fullManifest = deploymentManifest(input);
      if (options["dry-run"]) {
        io.writeStdout(
          jsonLine({
            command,
            dryRun: true,
            ok: true,
            toolVersion,
            result: {
              schemaVersion: 1,
              status: "planned",
              provider: fullManifest.provider.name,
              artifactDigest: fullManifest.artifact.digest,
              soakSeconds: fullManifest.verification.soakSeconds,
              rollbackAttemptLimit: fullManifest.rollback.attemptLimit,
            },
          }),
        );
        return 0;
      }
      if (typeof options.output !== "string") return fail(io, "output_required");
      const manifest: DeploymentManifest = {
        version: fullManifest.version,
        artifact: fullManifest.artifact,
        previousArtifact: fullManifest.previousArtifact,
        verification: fullManifest.verification,
        rollback: fullManifest.rollback,
      };
      const adapter = await selectAdapter(
        workingDirectory,
        options.adapter,
        fullManifest.provider,
      );
      const result = await orchestrateDeployment({
        manifest,
        adapter,
        verification: new RepositoryVerificationRunner(workingDirectory),
        clock: new SystemDeploymentClock(),
        intervalSeconds: 60,
      });
      await writeEvidence(options.output, result);
      io.writeStdout(jsonLine({ command, ok: result.status === "deployed", toolVersion, result }));
      return result.status === "deployed" ? 0 : 1;
    }

    if (command === "rollback") {
      const validation = validator.validate("rollback-input", input);
      if (!validation.ok) {
        io.writeStdout(jsonLine({ command, ok: false, errors: validation.errors, toolVersion }));
        return 1;
      }
      const rollbackInput = input as RollbackInput;
      if (options["dry-run"]) {
        const result = planRollback(rollbackInput);
        const resultValidation = validator.validate("rollback-result", result);
        if (!resultValidation.ok) return fail(io, "result_validation_failed");
        io.writeStdout(jsonLine({ command, dryRun: true, ok: true, toolVersion, result }));
        return 0;
      }
      if (typeof options.output !== "string") return fail(io, "output_required");
      const adapter = await selectAdapter(
        workingDirectory,
        options.adapter,
        rollbackInput.provider,
      );
      const result = await executeRollback({
        input: rollbackInput,
        adapter,
        verification: new RepositoryVerificationRunner(workingDirectory),
        clock: new SystemDeploymentClock(),
        intervalSeconds: 60,
      });
      const resultValidation = validator.validate("rollback-result", result);
      if (!resultValidation.ok) return fail(io, "result_validation_failed");
      await writeEvidence(options.output, result);
      io.writeStdout(jsonLine({ command, ok: result.status === "restored", toolVersion, result }));
      return result.status === "restored" ? 0 : 1;
    }

    if (command === "compliance" || command === "usage") {
      const validation = validator.validate("governance-result", input);
      if (!validation.ok) {
        io.writeStdout(jsonLine({ command, ok: false, errors: validation.errors, toolVersion }));
        return 1;
      }
      const governanceResult = input as GovernanceResultInput;
      if (command === "compliance") {
        const result = complianceView(governanceResult);
        io.writeStdout(jsonLine({ command, ok: result.status === "compliant", toolVersion, result }));
        return result.status === "compliant" ? 0 : 1;
      }
      const policy = JSON.parse(
        await readFile(join(repositoryRoot, "policies", "ci-budget.json"), "utf8"),
      ) as CiBudgetPolicy;
      const result = usageView(governanceResult, policy);
      const breached = Object.values(result.profiles).some((profile) => profile.withinTarget === false);
      io.writeStdout(jsonLine({ command, ok: !breached, toolVersion, result }));
      return breached ? 1 : 0;
    }

    if (command === "github-policy-repair") {
      const validation = validator.validate("github-policy-repair-input", input);
      if (!validation.ok) {
        io.writeStdout(jsonLine({ command, ok: false, errors: validation.errors, toolVersion }));
        return 1;
      }
      // Applying a repair requires the Phase 3 owner-scoped GitHub App, and each
      // setting's exact endpoint must be confirmed before it is written. Until
      // then the command plans only and refuses to claim it configured anything.
      if (!options["dry-run"]) return fail(io, "repair_apply_unavailable");
      const result = planGitHubPolicyRepair(input as GitHubPolicyRepairInput);
      const resultValidation = validator.validate("github-policy-repair-plan", result);
      if (!resultValidation.ok) return fail(io, "result_validation_failed");
      io.writeStdout(jsonLine({ command, dryRun: true, ok: true, toolVersion, result }));
      return 0;
    }

    if (command === "failure-policy") {
      const validation = validator.validate("failure-observation", input);
      if (!validation.ok) {
        io.writeStdout(jsonLine({ command, ok: false, errors: validation.errors, toolVersion }));
        return 1;
      }
      // A dry run must be reproducible, so the jittered retry uses the midpoint
      // of the window instead of a random draw.
      const jitterSource = options["dry-run"]
        ? () => 0.5
        : () => randomInt(0, 1_000_000) / 1_000_000;
      const result = decideFailureResponse(input as FailureObservation, jitterSource);
      const resultValidation = validator.validate("failure-decision", result);
      if (!resultValidation.ok) return fail(io, "result_validation_failed");
      io.writeStdout(jsonLine({
        command,
        dryRun: options["dry-run"] ?? false,
        ok: true,
        toolVersion,
        result,
      }));
      return 0;
    }

    if (command === "preflight") {
      const validation = validator.validate("preflight-run-input", input);
      if (!validation.ok) {
        io.writeStdout(jsonLine({ command, ok: false, errors: validation.errors, toolVersion }));
        return 1;
      }
      if (options["dry-run"]) {
        io.writeStdout(jsonLine({
          command,
          dryRun: true,
          ok: true,
          toolVersion,
          result: {
            status: "planned",
            headSha: (input as PreflightRunInput).headSha,
            commands: ["./scripts/delivery buildable", "./scripts/delivery affected"],
          },
        }));
        return 0;
      }
      if (typeof options.output !== "string") return fail(io, "output_required");
      const result = await runPreflight(input as PreflightRunInput, workingDirectory);
      const resultValidation = validator.validate("preflight-run-result", result);
      if (!resultValidation.ok) return fail(io, "result_validation_failed");
      await writeEvidence(options.output, result);
      io.writeStdout(jsonLine({ command, ok: result.status === "passed", toolVersion, result }));
      return result.status === "passed" ? 0 : 1;
    }

    if (command === "canary-plan" || command === "canary-audit") {
      const validation = validator.validate("canary-input", input);
      if (!validation.ok) {
        io.writeStdout(jsonLine({ command, ok: false, errors: validation.errors, toolVersion }));
        return 1;
      }
      const result = command === "canary-plan"
        ? planCanaries(input as CanaryInput)
        : auditCanaries(input as CanaryInput);
      const resultValidation = validator.validate("canary-result", result);
      if (!resultValidation.ok) return fail(io, "result_validation_failed");
      const ok = command === "canary-plan" ? result.status === "planned" : result.status === "passed";
      io.writeStdout(jsonLine({ command, dryRun: true, ok, toolVersion, result }));
      return ok ? 0 : 1;
    }

    if (command === "github-policy-audit") {
      const validation = validator.validate("github-policy-audit-input", input);
      if (!validation.ok) {
        io.writeStdout(jsonLine({ command, ok: false, errors: validation.errors, toolVersion }));
        return 1;
      }
      const policy = JSON.parse(await readFile(
        join(repositoryRoot, "policies", "branch-profiles.json"),
        "utf8",
      )) as BranchProfilesPolicy;
      const result = auditGitHubPolicy(input as GitHubPolicyAuditInput, policy);
      const resultValidation = validator.validate("github-policy-audit-result", result);
      if (!resultValidation.ok) return fail(io, "result_validation_failed");
      io.writeStdout(jsonLine({
        command,
        dryRun: options["dry-run"] ?? false,
        ok: result.status === "passed",
        toolVersion,
        result,
      }));
      return result.status === "passed" ? 0 : 1;
    }

    const validation = validator.validate("secrets-audit-input", input);
    if (!validation.ok) {
      io.writeStdout(jsonLine({ command, ok: false, errors: validation.errors, toolVersion }));
      return 1;
    }
    const result = auditSecrets(secretsAuditInput(input), new Date());
    io.writeStdout(jsonLine({ command, dryRun: options["dry-run"] ?? false, ok: result.status === "passed", toolVersion, result }));
    return result.status === "passed" ? 0 : 1;
  } catch (error) {
    if (error instanceof CertifyError) {
      return fail(io, error.code);
    }
    if (error instanceof RenderConflictError) {
      io.writeStderr(
        jsonLine({
          error: { code: "render_conflict", files: error.conflicts },
          ok: false,
          toolVersion,
        }),
      );
      return 1;
    }
    if (error instanceof PreflightError) return fail(io, error.code);
    if (error instanceof RollbackError) return fail(io, error.code);
    if (error instanceof FailurePolicyError) return fail(io, error.code);
    if (error instanceof GitHubPolicyRepairError) return fail(io, error.code);
    if (error instanceof GovernanceViewError) return fail(io, error.code);
    if (error instanceof AdapterUnavailableError) return fail(io, error.code);
    if (error instanceof InventoryAuditError) return fail(io, error.code);
    if (error instanceof BootstrapError) return fail(io, error.code);
    if (error instanceof PublishCheckError) return fail(io, error.code);
    if (error instanceof PromotionError) return fail(io, error.code);
    if (error instanceof ReleaseEvidenceError) return fail(io, error.code);
    if (
      error instanceof PaperclipFoundationError || error instanceof PaperclipControllersError ||
      error instanceof PaperclipBindingsError || error instanceof PaperclipTransitionAuthorizationError ||
      error instanceof PaperclipRoutinesError || error instanceof PaperclipGithubTransitionRoutineError ||
      error instanceof ReconciliationError
    ) return fail(io, error.code);
    return fail(io, "input_processing_failed");
  }
}
