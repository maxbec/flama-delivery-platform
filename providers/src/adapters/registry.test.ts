import { describe, expect, it } from "vitest";
import type { ProviderName } from "../orchestrator.js";
import { createBuiltinAdapter, AdapterUnavailableError, builtinProviders } from "./registry.js";
import type { CommandRunner, CommandResult } from "./docker-compose.js";

const runner: CommandRunner = {
  async run(): Promise<CommandResult> {
    return { code: 0, stdout: "" };
  },
};

const dockerComposeParameters = {
  composeFile: "deploy/compose.yaml",
  projectName: "flama-api",
  service: "api",
  deploymentUrl: "https://api.example.test",
};

describe("builtin deployment adapter registry", () => {
  it("builds the docker-compose adapter from repository-owned parameters", () => {
    const adapter = createBuiltinAdapter("docker-compose", dockerComposeParameters, runner);

    expect(adapter.name).toBe("docker-compose");
  });

  it("refuses a provider it cannot build rather than silently substituting one", () => {
    for (const provider of ["coolify", "render"] satisfies ProviderName[]) {
      let thrown: unknown;
      try {
        createBuiltinAdapter(provider, dockerComposeParameters, runner);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AdapterUnavailableError);
      expect((thrown as AdapterUnavailableError).code).toBe("adapter_not_implemented");
    }
  });

  it("directs the custom provider to the repository-supplied adapter instead of a builtin", () => {
    expect(() => createBuiltinAdapter("custom", dockerComposeParameters, runner))
      .toThrow(AdapterUnavailableError);
  });

  it("rejects docker-compose parameters that are incomplete", () => {
    expect(() => createBuiltinAdapter("docker-compose", { service: "api" }, runner))
      .toThrow(AdapterUnavailableError);
  });

  it("rejects a deployment URL that is not https", () => {
    expect(() => createBuiltinAdapter(
      "docker-compose",
      { ...dockerComposeParameters, deploymentUrl: "http://api.example.test" },
      runner,
    )).toThrow(AdapterUnavailableError);
  });

  it("rejects a compose file path that escapes the repository", () => {
    expect(() => createBuiltinAdapter(
      "docker-compose",
      { ...dockerComposeParameters, composeFile: "../elsewhere/compose.yaml" },
      runner,
    )).toThrow(AdapterUnavailableError);
  });
});

describe("remote docker host providers in the registry", () => {
  const remoteParameters = {
    ...dockerComposeParameters,
    dockerHost: "ssh://deploy@droplet.example.test",
  };

  it("builds the droplet and hostinger adapters from a remote docker endpoint", () => {
    for (const provider of ["digitalocean-droplet", "hostinger-vps"] satisfies ProviderName[]) {
      expect(createBuiltinAdapter(provider, remoteParameters, runner).name).toBe(provider);
    }
  });

  it("lists the remote docker providers as builtin", () => {
    expect(builtinProviders).toEqual([
      "docker-compose",
      "digitalocean-droplet",
      "hostinger-vps",
      "vercel-prebuilt",
      "digitalocean-app",
    ]);
  });

  it("requires a docker endpoint for a remote provider", () => {
    expect(() => createBuiltinAdapter("digitalocean-droplet", dockerComposeParameters, runner))
      .toThrow(AdapterUnavailableError);
  });

  it("requires the docker endpoint to be ssh so the transport is authenticated and encrypted", () => {
    for (const dockerHost of [
      "tcp://droplet.example.test:2375",
      "unix:///var/run/docker.sock",
      "ssh://deploy:secret@droplet.example.test",
      "http://droplet.example.test",
    ]) {
      expect(() => createBuiltinAdapter("hostinger-vps", { ...remoteParameters, dockerHost }, runner))
        .toThrow(AdapterUnavailableError);
    }
  });

  it("refuses a docker endpoint on a local compose deployment", () => {
    expect(() => createBuiltinAdapter("docker-compose", remoteParameters, runner))
      .toThrow(AdapterUnavailableError);
  });
});

describe("vercel prebuilt in the registry", () => {
  const vercelParameters = {
    projectId: "prj_abc123",
    deploymentUrl: "https://app.example.test",
    scope: "flama",
  };

  it("builds the vercel adapter when a token is available", () => {
    const adapter = createBuiltinAdapter("vercel-prebuilt", vercelParameters, runner, undefined, {
      vercelCredential: { reveal: () => "test-only-vercel-token" },
    });

    expect(adapter.name).toBe("vercel-prebuilt");
  });

  it("lists vercel among the builtin providers", () => {
    expect(builtinProviders).toContain("vercel-prebuilt");
  });

  it("refuses to build the vercel adapter without a token, instead of deploying unauthenticated", () => {
    let thrown: unknown;
    try {
      createBuiltinAdapter("vercel-prebuilt", vercelParameters, runner);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AdapterUnavailableError);
    expect((thrown as AdapterUnavailableError).code).toBe("adapter_credential_unavailable");
  });

  it("rejects vercel parameters that omit the project or use a non-https URL", () => {
    for (const parameters of [
      { ...vercelParameters, projectId: "" },
      { ...vercelParameters, deploymentUrl: "http://app.example.test" },
    ]) {
      expect(() => createBuiltinAdapter("vercel-prebuilt", parameters, runner, undefined, {
        vercelCredential: { reveal: () => "test-only-vercel-token" },
      })).toThrow(AdapterUnavailableError);
    }
  });

  it("does not treat a docker parameter set as valid vercel configuration", () => {
    expect(() => createBuiltinAdapter("vercel-prebuilt", dockerComposeParameters, runner, undefined, {
      vercelCredential: { reveal: () => "test-only-vercel-token" },
    })).toThrow(AdapterUnavailableError);
  });
});

describe("digitalocean app in the registry", () => {
  const doParameters = {
    appId: "abc-123",
    service: "api",
    registryType: "GHCR",
    registry: "maxbec",
    repository: "api",
    deploymentUrl: "https://api.example.test",
  };
  const credentials = { digitalOceanCredential: { reveal: () => "test-only-do-token" } };

  it("builds the digitalocean app adapter when a token is available", () => {
    expect(createBuiltinAdapter("digitalocean-app", doParameters, runner, undefined, credentials).name)
      .toBe("digitalocean-app");
  });

  it("refuses without a token instead of deploying unauthenticated", () => {
    let thrown: unknown;
    try {
      createBuiltinAdapter("digitalocean-app", doParameters, runner);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as AdapterUnavailableError).code).toBe("adapter_credential_unavailable");
  });

  it("rejects an unsupported registry type", () => {
    expect(() => createBuiltinAdapter(
      "digitalocean-app",
      { ...doParameters, registryType: "QUAY" },
      runner,
      undefined,
      credentials,
    )).toThrow(AdapterUnavailableError);
  });

  it("rejects a non-https deployment URL", () => {
    expect(() => createBuiltinAdapter(
      "digitalocean-app",
      { ...doParameters, deploymentUrl: "http://api.example.test" },
      runner,
      undefined,
      credentials,
    )).toThrow(AdapterUnavailableError);
  });

  it("still refuses coolify and render, which have unverified contracts", () => {
    for (const provider of ["coolify", "render"] satisfies ProviderName[]) {
      let thrown: unknown;
      try {
        createBuiltinAdapter(provider, doParameters, runner, undefined, credentials);
      } catch (error) {
        thrown = error;
      }
      expect((thrown as AdapterUnavailableError).code).toBe("adapter_not_implemented");
    }
  });
});
