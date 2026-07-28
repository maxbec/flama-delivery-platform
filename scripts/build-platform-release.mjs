#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: root,
      env: process.env,
      stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    let stdout = "";
    if (options.capture) child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (signal !== null || code !== 0) rejectRun(new Error(`${command} failed`));
      else resolveRun(stdout.trim());
    });
  });
}

async function sha256(path) {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return `sha256:${hash.digest("hex")}`;
}

function spdxId(name, version) {
  return `SPDXRef-Package-${createHash("sha256").update(`${name}@${version}`).digest("hex").slice(0, 16)}`;
}

function npmPurl(name, version) {
  if (name.startsWith("@") && name.includes("/")) {
    const [scope, packageName] = name.split("/", 2);
    return `pkg:npm/${encodeURIComponent(scope)}/${encodeURIComponent(packageName)}@${version}`;
  }
  return `pkg:npm/${encodeURIComponent(name)}@${version}`;
}

function collectPackages(rootPackage) {
  const packages = new Map();
  const relationships = new Set();

  function visit(name, dependency, parentId) {
    if (typeof dependency !== "object" || dependency === null || typeof dependency.version !== "string") return;
    const id = spdxId(name, dependency.version);
    if (!packages.has(id)) {
      packages.set(id, {
        SPDXID: id,
        name,
        versionInfo: dependency.version,
        downloadLocation:
          typeof dependency.resolved === "string" && dependency.resolved.startsWith("https://")
            ? dependency.resolved
            : "NOASSERTION",
        filesAnalyzed: false,
        licenseConcluded: "NOASSERTION",
        licenseDeclared: "NOASSERTION",
        copyrightText: "NOASSERTION",
        externalRefs: [
          {
            referenceCategory: "PACKAGE-MANAGER",
            referenceType: "purl",
            referenceLocator: npmPurl(name, dependency.version),
          },
        ],
      });
    }
    relationships.add(`${parentId}|${id}`);
    for (const [childName, child] of Object.entries(dependency.dependencies ?? {})) visit(childName, child, id);
  }

  const documentRootId = spdxId(rootPackage.name, rootPackage.version);
  packages.set(documentRootId, {
    SPDXID: documentRootId,
    name: rootPackage.name,
    versionInfo: rootPackage.version,
    downloadLocation: "https://github.com/maxbec/flama-delivery-platform",
    filesAnalyzed: false,
    licenseConcluded: "NOASSERTION",
    licenseDeclared: "NOASSERTION",
    copyrightText: "NOASSERTION",
  });
  for (const [name, dependency] of Object.entries(rootPackage.dependencies ?? {})) {
    visit(name, dependency, documentRootId);
  }
  return {
    rootId: documentRootId,
    packages: [...packages.values()].sort((left, right) => left.SPDXID.localeCompare(right.SPDXID)),
    relationships: [...relationships]
      .sort()
      .map((entry) => {
        const [from, to] = entry.split("|");
        return { spdxElementId: from, relationshipType: "DEPENDS_ON", relatedSpdxElement: to };
      }),
  };
}

async function listFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path, relativePath)));
    else if (entry.isFile()) files.push({ path: relativePath, digest: await sha256(path) });
    else throw new Error("release staging contains a non-regular entry");
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function writeTarGzip(sourceDirectory, entryName, outputPath, epoch) {
  await new Promise((resolveArchive, rejectArchive) => {
    const tar = spawn(
      "tar",
      [
        "--sort=name",
        `--mtime=@${epoch}`,
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "--format=posix",
        "--pax-option=delete=atime,delete=ctime",
        "-C",
        sourceDirectory,
        "-cf",
        "-",
        entryName,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const gzip = spawn("gzip", ["-n", "-9"], { stdio: ["pipe", "pipe", "inherit"] });
    const chunks = [];
    tar.stdout.pipe(gzip.stdin);
    gzip.stdout.on("data", (chunk) => chunks.push(chunk));
    let tarDone = false;
    let gzipDone = false;
    let failed = false;
    const finish = () => {
      if (!failed && tarDone && gzipDone) {
        writeFile(outputPath, Buffer.concat(chunks), { flag: "wx", mode: 0o644 })
          .then(resolveArchive, rejectArchive);
      }
    };
    const fail = (error) => {
      if (!failed) {
        failed = true;
        rejectArchive(error);
      }
    };
    tar.once("error", fail);
    gzip.once("error", fail);
    tar.once("exit", (code, signal) => {
      if (signal !== null || code !== 0) fail(new Error("tar failed"));
      else {
        tarDone = true;
        finish();
      }
    });
    gzip.once("exit", (code, signal) => {
      if (signal !== null || code !== 0) fail(new Error("gzip failed"));
      else {
        gzipDone = true;
        finish();
      }
    });
  });
}

function outputDirectoryFromArgs(args) {
  if (args.length === 0) return join(root, "release");
  if (args.length === 2 && args[0] === "--output-dir") return resolve(args[1]);
  throw new Error("usage: build-platform-release.mjs [--output-dir <directory>]");
}

const outputDirectory = outputDirectoryFromArgs(process.argv.slice(2));
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const version = packageJson.version;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/u.test(version)) throw new Error("invalid version");
const commitSha = await run("git", ["rev-parse", "HEAD"], { capture: true });
const epoch = await run("git", ["show", "-s", "--format=%ct", "HEAD"], { capture: true });
const createdAt = new Date(Number(epoch) * 1_000).toISOString();
const releaseName = `flama-delivery-platform-v${version}`;
const temporaryRoot = await mkdtemp(join(tmpdir(), "flama-platform-release-"));

try {
  const bundleDirectory = join(temporaryRoot, "bundle");
  const stageDirectory = join(temporaryRoot, releaseName);
  await mkdir(join(stageDirectory, "bin"), { recursive: true });
  await run("bash", ["scripts/build-cli-bundle.sh", bundleDirectory]);
  await copyFile(join(bundleDirectory, "index.js"), join(stageDirectory, "bin", "flama-delivery-ctl.js"));
  await chmod(join(stageDirectory, "bin", "flama-delivery-ctl.js"), 0o755);
  await copyFile(
    join(bundleDirectory, "THIRD_PARTY_LICENSES.txt"),
    join(stageDirectory, "THIRD_PARTY_LICENSES.txt"),
  );
  await writeFile(
    join(stageDirectory, "package.json"),
    `${JSON.stringify({ name: packageJson.name, version, private: true, type: "module", engines: packageJson.engines }, null, 2)}\n`,
    { flag: "wx" },
  );

  for (const path of ["schemas", "policies", "templates", "lifecycles", "skills"]) {
    await cp(join(root, path), join(stageDirectory, path), { recursive: true, errorOnExist: true });
  }
  await mkdir(join(stageDirectory, "scripts"), { recursive: true });
  await copyFile(
    join(root, "scripts", "consumer-policy-gate.mjs"),
    join(stageDirectory, "scripts", "consumer-policy-gate.mjs"),
  );
  await cp(join(root, ".github", "workflows"), join(stageDirectory, ".github", "workflows"), {
    recursive: true,
    errorOnExist: true,
  });
  await cp(
    join(root, "services", "bridge", "migrations"),
    join(stageDirectory, "services", "bridge", "migrations"),
    { recursive: true, errorOnExist: true },
  );

  const listed = JSON.parse(await run("pnpm", ["list", "--prod", "--json", "--depth", "Infinity"], { capture: true }));
  const dependencyTree = listed.find((entry) => entry.name === packageJson.name);
  if (dependencyTree === undefined) throw new Error("package tree is missing");
  const collected = collectPackages(dependencyTree);
  const sbom = {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `${releaseName}-sbom`,
    documentNamespace: `https://github.com/maxbec/flama-delivery-platform/releases/v${version}/sbom/${commitSha}`,
    creationInfo: { created: createdAt, creators: ["Tool: flama-delivery-platform-release-builder"] },
    documentDescribes: [collected.rootId],
    packages: collected.packages,
    relationships: collected.relationships,
  };
  const sbomName = `${releaseName}.sbom.spdx.json`;
  await writeFile(join(stageDirectory, sbomName), `${JSON.stringify(sbom, null, 2)}\n`, { flag: "wx" });

  const files = await listFiles(stageDirectory);
  const manifest = {
    schemaVersion: 1,
    version,
    commitSha,
    createdAt,
    nodeMajor: 26,
    cli: "bin/flama-delivery-ctl.js",
    sbom: sbomName,
    files,
  };
  await writeFile(join(stageDirectory, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: "wx",
  });

  const temporaryArchive = join(temporaryRoot, `${releaseName}.tar.gz`);
  await writeTarGzip(temporaryRoot, releaseName, temporaryArchive, epoch);
  const archiveDigest = await sha256(temporaryArchive);
  await mkdir(outputDirectory, { recursive: true });
  const archivePath = join(outputDirectory, basename(temporaryArchive));
  const externalSbomPath = join(outputDirectory, sbomName);
  const checksumPath = `${archivePath}.sha256`;
  await copyFile(temporaryArchive, archivePath, constants.COPYFILE_EXCL);
  await copyFile(join(stageDirectory, sbomName), externalSbomPath, constants.COPYFILE_EXCL);
  await writeFile(checksumPath, `${archiveDigest.slice("sha256:".length)}  ${basename(archivePath)}\n`, {
    flag: "wx",
  });
  process.stdout.write(
    `${JSON.stringify({ version, commitSha, artifact: archivePath, digest: archiveDigest, sbom: externalSbomPath })}\n`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
