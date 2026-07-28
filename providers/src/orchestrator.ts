export type ProviderName =
  | "docker-compose"
  | "vercel-prebuilt"
  | "digitalocean-app"
  | "digitalocean-droplet"
  | "hostinger-vps"
  | "coolify"
  | "render"
  | "custom";

export interface ArtifactReference {
  readonly uri: string;
  readonly digest: string;
}

export interface DeploymentManifest {
  readonly version: string;
  readonly artifact: ArtifactReference;
  readonly previousArtifact: ArtifactReference | null;
  readonly verification: {
    readonly expectedVersion: string;
    readonly soakSeconds: number;
  };
  readonly rollback: {
    readonly automatic: boolean;
    readonly attemptLimit: number;
  };
}

export interface ProviderEvidence {
  readonly deploymentId: string;
  readonly observedAt: string;
}

export interface DeploymentAdapter {
  readonly name: ProviderName;
  validate(manifest: DeploymentManifest): Promise<boolean>;
  deploy(artifact: ArtifactReference, manifest: DeploymentManifest): Promise<void>;
  health(): Promise<boolean>;
  rollback(previousArtifact: ArtifactReference): Promise<void>;
  deploymentUrl(): Promise<string>;
  deployedVersion(): Promise<string>;
  evidence(): Promise<ProviderEvidence>;
}

export interface VerificationRunner {
  smoke(expectedVersion: string): Promise<boolean>;
}

export interface DeploymentClock {
  now(): Date;
  wait(seconds: number): Promise<void>;
}

export interface DeploymentCheck {
  readonly observedAt: string;
  readonly phase: "immediate" | "soak";
  readonly health: boolean;
  readonly version: boolean;
  readonly smoke: boolean;
}

export type DeploymentStatus = "deployed" | "rolled_back" | "rollback_failed" | "failed";

export interface DeploymentResult {
  readonly schemaVersion: 1;
  readonly status: DeploymentStatus;
  readonly provider: ProviderName;
  readonly artifactDigest: string;
  readonly previousArtifactDigest: string | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly rollbackAttempts: 0 | 1;
  readonly reasonCode?: string;
  readonly deploymentUrl?: string;
  readonly providerEvidence?: ProviderEvidence;
  readonly checks: readonly DeploymentCheck[];
}

interface OrchestrationOptions {
  readonly manifest: DeploymentManifest;
  readonly adapter: DeploymentAdapter;
  readonly verification: VerificationRunner;
  readonly clock: DeploymentClock;
  readonly intervalSeconds: number;
}

function baseResult(
  options: OrchestrationOptions,
  startedAt: string,
  checks: readonly DeploymentCheck[],
): Omit<DeploymentResult, "status" | "rollbackAttempts" | "finishedAt"> {
  return {
    schemaVersion: 1,
    provider: options.adapter.name,
    artifactDigest: options.manifest.artifact.digest,
    previousArtifactDigest: options.manifest.previousArtifact?.digest ?? null,
    startedAt,
    checks,
  };
}

async function checkDeployment(
  options: OrchestrationOptions,
  phase: "immediate" | "soak",
): Promise<{ readonly check: DeploymentCheck; readonly reasonCode?: string }> {
  const health = await options.adapter.health();
  const version = (await options.adapter.deployedVersion()) === options.manifest.verification.expectedVersion;
  const smoke = await options.verification.smoke(options.manifest.verification.expectedVersion);
  const check: DeploymentCheck = {
    observedAt: options.clock.now().toISOString(),
    phase,
    health,
    version,
    smoke,
  };
  if (!health) return { check, reasonCode: "health_failed" };
  if (!version) return { check, reasonCode: "version_mismatch" };
  if (!smoke) return { check, reasonCode: "smoke_failed" };
  return { check };
}

async function failureResult(
  options: OrchestrationOptions,
  startedAt: string,
  checks: readonly DeploymentCheck[],
  reasonCode: string,
  deploymentAttempted: boolean,
): Promise<DeploymentResult> {
  const base = baseResult(options, startedAt, checks);
  if (!deploymentAttempted || options.manifest.previousArtifact === null) {
    return {
      ...base,
      status: "failed",
      reasonCode: deploymentAttempted ? "rollback_unavailable" : reasonCode,
      rollbackAttempts: 0,
      finishedAt: options.clock.now().toISOString(),
    };
  }

  try {
    await options.adapter.rollback(options.manifest.previousArtifact);
    const rollbackHealthy = await options.adapter.health();
    return {
      ...base,
      status: rollbackHealthy ? "rolled_back" : "rollback_failed",
      reasonCode: rollbackHealthy ? reasonCode : "rollback_health_failed",
      rollbackAttempts: 1,
      finishedAt: options.clock.now().toISOString(),
    };
  } catch {
    return {
      ...base,
      status: "rollback_failed",
      reasonCode: "rollback_failed",
      rollbackAttempts: 1,
      finishedAt: options.clock.now().toISOString(),
    };
  }
}

export async function orchestrateDeployment(options: OrchestrationOptions): Promise<DeploymentResult> {
  const startedAt = options.clock.now().toISOString();
  const checks: DeploymentCheck[] = [];
  if (
    options.manifest.verification.soakSeconds < 600 ||
    !options.manifest.rollback.automatic ||
    options.manifest.rollback.attemptLimit !== 1 ||
    options.intervalSeconds <= 0 ||
    options.intervalSeconds > options.manifest.verification.soakSeconds
  ) {
    return failureResult(options, startedAt, checks, "unsafe_deployment_policy", false);
  }

  let deploymentAttempted = false;
  try {
    if (!(await options.adapter.validate(options.manifest))) {
      return failureResult(options, startedAt, checks, "adapter_validation_failed", false);
    }
    deploymentAttempted = true;
    await options.adapter.deploy(options.manifest.artifact, options.manifest);

    const immediate = await checkDeployment(options, "immediate");
    checks.push(immediate.check);
    if (immediate.reasonCode !== undefined) {
      return failureResult(options, startedAt, checks, immediate.reasonCode, deploymentAttempted);
    }

    let elapsedSeconds = 0;
    while (elapsedSeconds < options.manifest.verification.soakSeconds) {
      const waitSeconds = Math.min(
        options.intervalSeconds,
        options.manifest.verification.soakSeconds - elapsedSeconds,
      );
      await options.clock.wait(waitSeconds);
      elapsedSeconds += waitSeconds;
      const soak = await checkDeployment(options, "soak");
      checks.push(soak.check);
      if (soak.reasonCode !== undefined) {
        return failureResult(options, startedAt, checks, soak.reasonCode, deploymentAttempted);
      }
    }

    const deploymentUrl = await options.adapter.deploymentUrl();
    const url = new URL(deploymentUrl);
    if (url.username.length > 0 || url.password.length > 0 || url.protocol !== "https:") {
      return failureResult(options, startedAt, checks, "unsafe_deployment_url", deploymentAttempted);
    }
    const rawProviderEvidence = await options.adapter.evidence();
    if (
      rawProviderEvidence.deploymentId.length === 0 ||
      Number.isNaN(Date.parse(rawProviderEvidence.observedAt))
    ) {
      return failureResult(options, startedAt, checks, "invalid_provider_evidence", deploymentAttempted);
    }
    const providerEvidence: ProviderEvidence = {
      deploymentId: rawProviderEvidence.deploymentId,
      observedAt: rawProviderEvidence.observedAt,
    };
    return {
      ...baseResult(options, startedAt, checks),
      status: "deployed",
      rollbackAttempts: 0,
      finishedAt: options.clock.now().toISOString(),
      deploymentUrl,
      providerEvidence,
    };
  } catch {
    return failureResult(options, startedAt, checks, "deployment_error", deploymentAttempted);
  }
}
