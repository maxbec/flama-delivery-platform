import type { DeploymentAdapter, ProviderName } from "../orchestrator.js";
import type { DockerComposeConfiguration } from "./docker-compose.js";
import {
  createVercelAdapter,
  type VercelConfiguration,
  type VercelCredential,
  type VercelDeploymentReader,
} from "./vercel.js";
import { VercelRestDeploymentReader } from "./vercel-reader.js";
import {
  createDigitalOceanAppAdapter,
  type DigitalOceanAppClient,
  type DigitalOceanAppConfiguration,
  type DigitalOceanRegistryType,
} from "./digitalocean-app.js";
import { DigitalOceanRestAppClient, type DigitalOceanCredential } from "./digitalocean-client.js";
import {
  createDockerHostAdapter,
  type CommandRunner,
  type DockerHostConfiguration,
  type DockerHostProvider,
} from "./docker-compose.js";

export type AdapterUnavailableCode =
  | "adapter_not_implemented"
  | "adapter_parameters_invalid"
  | "adapter_credential_unavailable";

export class AdapterUnavailableError extends Error {
  constructor(readonly code: AdapterUnavailableCode) {
    super("Deployment adapter unavailable");
    this.name = "AdapterUnavailableError";
  }
}

/**
 * Plan section 14 names eight providers. Only the implemented ones are listed
 * here: an unimplemented provider fails closed rather than falling back to a
 * different deployment mechanism. `custom` is deliberately excluded because it
 * is by definition supplied by the consumer repository.
 */
export const builtinProviders = [
  "docker-compose",
  "digitalocean-droplet",
  "hostinger-vps",
  "vercel-prebuilt",
  "digitalocean-app",
] as const satisfies readonly ProviderName[];

/**
 * A provider that authenticates to an external control plane needs a credential.
 * It is injected rather than read from the ambient environment so the caller
 * decides which identity a deployment runs under.
 */
export interface AdapterDependencies {
  readonly vercelCredential?: VercelCredential;
  readonly vercelReader?: VercelDeploymentReader;
  readonly digitalOceanCredential?: DigitalOceanCredential;
  readonly digitalOceanClient?: DigitalOceanAppClient;
}

const registryTypes: readonly DigitalOceanRegistryType[] = ["DOCKER_HUB", "DOCR", "GHCR"];

function digitalOceanConfiguration(
  parameters: Readonly<Record<string, unknown>>,
): DigitalOceanAppConfiguration {
  const { appId, service, registryType, registry, repository, deploymentUrl } = parameters;
  if (
    typeof appId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(appId) ||
    typeof service !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/u.test(service) ||
    typeof registryType !== "string" ||
    !registryTypes.includes(registryType as DigitalOceanRegistryType) ||
    (registry !== undefined && (typeof registry !== "string" || registry.length === 0)) ||
    typeof repository !== "string" || repository.length === 0 ||
    typeof deploymentUrl !== "string"
  ) throw new AdapterUnavailableError("adapter_parameters_invalid");

  let url: URL;
  try {
    url = new URL(deploymentUrl);
  } catch {
    throw new AdapterUnavailableError("adapter_parameters_invalid");
  }
  if (url.protocol !== "https:" || url.username.length > 0 || url.password.length > 0) {
    throw new AdapterUnavailableError("adapter_parameters_invalid");
  }
  return {
    appId,
    service,
    registryType: registryType as DigitalOceanRegistryType,
    ...(registry === undefined ? {} : { registry: registry as string }),
    repository,
    deploymentUrl,
  };
}

function vercelConfiguration(parameters: Readonly<Record<string, unknown>>): VercelConfiguration {
  const { projectId, deploymentUrl, scope } = parameters;
  if (
    typeof projectId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(projectId) ||
    typeof deploymentUrl !== "string" ||
    (scope !== undefined && (typeof scope !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(scope)))
  ) throw new AdapterUnavailableError("adapter_parameters_invalid");

  let url: URL;
  try {
    url = new URL(deploymentUrl);
  } catch {
    throw new AdapterUnavailableError("adapter_parameters_invalid");
  }
  if (url.protocol !== "https:" || url.username.length > 0 || url.password.length > 0) {
    throw new AdapterUnavailableError("adapter_parameters_invalid");
  }
  return { projectId, deploymentUrl, ...(scope === undefined ? {} : { scope }) };
}

function isDockerHostProvider(provider: ProviderName): provider is DockerHostProvider {
  return provider === "docker-compose" || provider === "digitalocean-droplet" || provider === "hostinger-vps";
}

const repositoryRelativePath = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._\-/]+$/u;

/**
 * A remote endpoint must be SSH: Docker's TCP endpoint is unauthenticated and
 * unencrypted by default, and a local socket is not a remote deployment. An
 * embedded password is refused because a credential belongs in Infisical and in
 * the SSH agent, never in a manifest parameter.
 */
function dockerEndpoint(value: unknown): string {
  if (typeof value !== "string") throw new AdapterUnavailableError("adapter_parameters_invalid");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AdapterUnavailableError("adapter_parameters_invalid");
  }
  if (url.protocol !== "ssh:" || url.hostname.length === 0 || url.password.length > 0) {
    throw new AdapterUnavailableError("adapter_parameters_invalid");
  }
  return value;
}

function dockerHostConfiguration(
  provider: DockerHostProvider,
  parameters: Readonly<Record<string, unknown>>,
): DockerHostConfiguration {
  const local = provider === "docker-compose";
  if (local && parameters["dockerHost"] !== undefined) {
    throw new AdapterUnavailableError("adapter_parameters_invalid");
  }
  if (!local && parameters["dockerHost"] === undefined) {
    throw new AdapterUnavailableError("adapter_parameters_invalid");
  }
  return {
    ...dockerComposeConfiguration(parameters),
    provider,
    ...(local ? {} : { dockerHost: dockerEndpoint(parameters["dockerHost"]) }),
  };
}

function dockerComposeConfiguration(parameters: Readonly<Record<string, unknown>>): DockerComposeConfiguration {
  const { composeFile, projectName, service, deploymentUrl } = parameters;
  if (
    typeof composeFile !== "string" || !repositoryRelativePath.test(composeFile) ||
    typeof projectName !== "string" || !/^[a-z0-9][a-z0-9_-]{0,62}$/u.test(projectName) ||
    typeof service !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/u.test(service) ||
    typeof deploymentUrl !== "string"
  ) throw new AdapterUnavailableError("adapter_parameters_invalid");

  let url: URL;
  try {
    url = new URL(deploymentUrl);
  } catch {
    throw new AdapterUnavailableError("adapter_parameters_invalid");
  }
  if (url.protocol !== "https:" || url.username.length > 0 || url.password.length > 0) {
    throw new AdapterUnavailableError("adapter_parameters_invalid");
  }
  return { composeFile, projectName, service, deploymentUrl };
}

export function createBuiltinAdapter(
  provider: ProviderName,
  parameters: Readonly<Record<string, unknown>>,
  runner: CommandRunner,
  now?: () => Date,
  dependencies: AdapterDependencies = {},
): DeploymentAdapter {
  if (isDockerHostProvider(provider)) {
    return createDockerHostAdapter(dockerHostConfiguration(provider, parameters), runner, now);
  }
  if (provider === "vercel-prebuilt") {
    const credential = dependencies.vercelCredential;
    if (credential === undefined) throw new AdapterUnavailableError("adapter_credential_unavailable");
    const configuration = vercelConfiguration(parameters);
    const reader = dependencies.vercelReader ??
      new VercelRestDeploymentReader(credential, undefined, configuration.scope);
    return createVercelAdapter(configuration, runner, reader, credential, now);
  }
  if (provider === "digitalocean-app") {
    const credential = dependencies.digitalOceanCredential;
    if (credential === undefined && dependencies.digitalOceanClient === undefined) {
      throw new AdapterUnavailableError("adapter_credential_unavailable");
    }
    const configuration = digitalOceanConfiguration(parameters);
    const client = dependencies.digitalOceanClient ??
      new DigitalOceanRestAppClient(credential as DigitalOceanCredential);
    return createDigitalOceanAppAdapter(configuration, client, now);
  }
  throw new AdapterUnavailableError("adapter_not_implemented");
}
