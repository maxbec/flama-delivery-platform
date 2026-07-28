#!/usr/bin/env node
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

const maximumFileBytes = 1024 * 1024;
const commandNames = ["buildable", "affected", "full", "smoke", "health"];
const commandContract = Object.fromEntries(
  commandNames.map((name) => [name, `./scripts/delivery ${name}`]),
);

function rejectPolicy() {
  throw new Error("consumer policy rejected");
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isObject(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

async function readRegular(root, relativePath) {
  const path = join(root, relativePath);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumFileBytes) {
    rejectPolicy();
  }
  return readFile(path, "utf8");
}

async function readJson(root, relativePath) {
  try {
    return JSON.parse(await readRegular(root, relativePath));
  } catch {
    rejectPolicy();
  }
}

function assertContract(contract, profile) {
  const expectedBranch = profile === "major" ? "dev" : "main";
  if (
    !exactKeys(contract, [
      "schemaVersion",
      "repository",
      "paperclip",
      "profile",
      "branches",
      "commands",
      "changeDetection",
      "release",
      "deployment",
      "secrets",
      "platform",
    ]) ||
    contract.schemaVersion !== 1 ||
    contract.profile !== profile ||
    !exactKeys(contract.repository, ["owner", "name", "visibility"]) ||
    !["maxbec", "navigaite", "edilio"].includes(contract.repository.owner) ||
    typeof contract.repository.name !== "string" ||
    !["private", "public"].includes(contract.repository.visibility) ||
    !exactKeys(contract.paperclip, ["company", "projectId", "workspaceId"]) ||
    contract.paperclip.company !==
      ({ maxbec: "Private", navigaite: "// Navigaite", edilio: "Edilio" })[
        contract.repository.owner
      ] ||
    typeof contract.paperclip.projectId !== "string" ||
    typeof contract.paperclip.workspaceId !== "string" ||
    !exactKeys(contract.branches, ["default", "stable", "featureTarget"]) ||
    contract.branches.default !== expectedBranch ||
    contract.branches.stable !== "main" ||
    contract.branches.featureTarget !== expectedBranch ||
    !exactKeys(contract.commands, commandNames) ||
    commandNames.some((name) => contract.commands[name] !== commandContract[name]) ||
    !exactKeys(contract.changeDetection, ["failClosed", "broadenOn"]) ||
    contract.changeDetection.failClosed !== true ||
    !Array.isArray(contract.changeDetection.broadenOn) ||
    new Set(contract.changeDetection.broadenOn).size !== contract.changeDetection.broadenOn.length ||
    contract.changeDetection.broadenOn.some(
      (value) =>
        ![
          "shared_packages",
          "lockfiles",
          "ci_build_tooling",
          "authentication",
          "database_schema",
          "breaking_change",
          "uncertain_detection",
        ].includes(value),
    ) ||
    !["lockfiles", "authentication", "database_schema", "uncertain_detection"].every((value) =>
      contract.changeDetection.broadenOn.includes(value),
    ) ||
    !exactKeys(contract.release, ["enabled", "strategy", "impactSource", "type"]) ||
    contract.release.strategy !== "release-please" ||
    contract.release.impactSource !== "paperclip_task" ||
    typeof contract.release.enabled !== "boolean" ||
    !["node", "python", "php", "flutter", "go", "simple"].includes(contract.release.type) ||
    !exactKeys(contract.deployment, ["deployable", "provider", "manifestPath"]) ||
    typeof contract.deployment.deployable !== "boolean" ||
    ![
      "none",
      "docker-compose",
      "vercel-prebuilt",
      "digitalocean-app",
      "digitalocean-droplet",
      "hostinger-vps",
      "coolify",
      "render",
      "custom",
    ].includes(contract.deployment.provider) ||
    contract.deployment.manifestPath !== ".deploy/production.yaml" ||
    !exactKeys(contract.secrets, ["source", "projectSlug", "paths", "exceptionsFile"]) ||
    contract.secrets.source !== "infisical" ||
    typeof contract.secrets.projectSlug !== "string" ||
    contract.secrets.projectSlug.length === 0 ||
    !isObject(contract.secrets.paths) ||
    Object.values(contract.secrets.paths).some(
      (path) => typeof path !== "string" || !path.startsWith("/"),
    ) ||
    contract.secrets.exceptionsFile !== ".flama/secret-exceptions.json" ||
    !exactKeys(contract.platform, ["repository", "version"]) ||
    contract.platform.repository !== "maxbec/flama-delivery-platform" ||
    !/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(contract.platform.version)
  ) {
    rejectPolicy();
  }
}

function assertPlatformLock(lock, contract, platformSha) {
  if (
    !exactKeys(lock, ["schemaVersion", "repository", "version", "ref"]) ||
    lock.schemaVersion !== 1 ||
    lock.repository !== "maxbec/flama-delivery-platform" ||
    lock.version !== contract.platform.version ||
    lock.ref !== platformSha
  ) {
    rejectPolicy();
  }
}

function assertWebhookMetadata(metadata, contract, appSlug) {
  if (
    !exactKeys(metadata, [
      "schemaVersion",
      "repository",
      "company",
      "projectId",
      "workspaceId",
      "appSlug",
      "events",
    ]) ||
    metadata.schemaVersion !== 1 ||
    metadata.repository !== `${contract.repository.owner}/${contract.repository.name}` ||
    metadata.company !== contract.paperclip.company ||
    metadata.projectId !== contract.paperclip.projectId ||
    metadata.workspaceId !== contract.paperclip.workspaceId ||
    metadata.appSlug !== appSlug ||
    !Array.isArray(metadata.events)
  ) {
    rejectPolicy();
  }
}

async function assertEntrypoints(root) {
  const script = await lstat(join(root, "scripts", "delivery"));
  if (!script.isFile() || script.isSymbolicLink() || (script.mode & 0o111) === 0) rejectPolicy();
  const commands = await readJson(root, ".flama/commands.json");
  if (
    !exactKeys(commands, commandNames) ||
    commandNames.some(
      (name) =>
        !Array.isArray(commands[name]) ||
        commands[name].length === 0 ||
        commands[name].some(
          (part) =>
            typeof part !== "string" ||
            part.length === 0 ||
            part.length > 1024 ||
            /[\r\n]/u.test(part) ||
            /(?:token|secret|password|api[_-]?key)\s*=/iu.test(part) ||
            /(?:gh[pousr]_|github_pat_)/u.test(part) ||
            /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+:[^/@\s]+@/iu.test(part),
        ),
    )
  ) {
    rejectPolicy();
  }
  await readRegular(root, ".flama/run-command.mjs");
  const agents = await readRegular(root, "AGENTS.md");
  if (
    agents.split("<!-- flama-delivery:start -->").length !== 2 ||
    agents.split("<!-- flama-delivery:end -->").length !== 2
  ) {
    rejectPolicy();
  }
  await readRegular(root, ".paperclip/project.yaml");
}

async function assertGeneratedFiles(root, profile, platformSha, releaseEnabled) {
  const workflowNames = ["flama-branch-guard.yml", "flama-deploy.yml", "flama-final.yml", "flama-policy.yml"];
  for (const workflowName of workflowNames) {
    const source = await readRegular(root, `.github/workflows/${workflowName}`);
    if (
      !source.includes(`@${platformSha}`) ||
      /pull_request_target|secrets:\s*inherit/u.test(source) ||
      (workflowName !== "flama-deploy.yml" && /id-token:\s*write/u.test(source))
    ) {
      rejectPolicy();
    }
  }
  const dependabot = await readRegular(root, ".github/dependabot.yml");
  if (
    !dependabot.includes("package-ecosystem: github-actions") ||
    !dependabot.includes(`target-branch: ${profile === "major" ? "dev" : "main"}`)
  ) {
    rejectPolicy();
  }
  const codeowners = await readRegular(root, ".github/CODEOWNERS");
  if (!codeowners.includes("/.deploy/production.yaml @maxbec")) rejectPolicy();
  if (releaseEnabled) {
    await readJson(root, ".release-please-config.json");
    await readJson(root, ".release-please-manifest.json");
  }
}

export async function validateConsumerPolicy(rootInput, baseRef, profile, platformSha, appSlug) {
  if (
    !["fast", "major"].includes(profile) ||
    (profile === "fast" ? baseRef !== "main" : !["dev", "main"].includes(baseRef)) ||
    !/^[0-9a-f]{40}$/u.test(platformSha) ||
    !/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/u.test(appSlug)
  ) {
    rejectPolicy();
  }
  const root = await realpath(resolve(rootInput));
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) rejectPolicy();
  const contract = await readJson(root, ".flama/delivery-contract.json");
  assertContract(contract, profile);
  assertPlatformLock(await readJson(root, ".flama/platform-lock.json"), contract, platformSha);
  assertWebhookMetadata(
    await readJson(root, ".flama/paperclip-webhook.json"),
    contract,
    appSlug,
  );
  await assertEntrypoints(root);
  await assertGeneratedFiles(root, profile, platformSha, contract.release.enabled);
  return { ok: true, profile, baseRef, platformSha };
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  try {
    const [root, baseRef, profile, platformSha, appSlug, extra] = process.argv.slice(2);
    if (
      root === undefined ||
      baseRef === undefined ||
      profile === undefined ||
      platformSha === undefined ||
      appSlug === undefined ||
      extra !== undefined
    ) {
      rejectPolicy();
    }
    process.stdout.write(`${JSON.stringify(await validateConsumerPolicy(root, baseRef, profile, platformSha, appSlug))}\n`);
  } catch {
    process.stderr.write('{"error":{"code":"consumer_policy_rejected"},"ok":false}\n');
    process.exitCode = 1;
  }
}
