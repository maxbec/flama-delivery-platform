#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const allowedCommands = new Set(["buildable", "affected", "full", "smoke", "health"]);

export async function loadCommand(name, configurationUrl = new URL("./commands.json", import.meta.url)) {
  if (!allowedCommands.has(name)) throw new Error("unsupported delivery command");
  const parsed = JSON.parse(await readFile(configurationUrl, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("invalid delivery command configuration");
  }
  const command = parsed[name];
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    !command.every((item) => typeof item === "string" && item.length > 0)
  ) {
    throw new Error("invalid delivery command configuration");
  }
  return command;
}

export async function run(name) {
  const [executable, ...args] = await loadCommand(name);
  const child = spawn(executable, args, {
    cwd: new URL("../", import.meta.url),
    env: process.env,
    shell: false,
    stdio: "inherit",
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) reject(new Error("delivery command terminated by signal"));
      else resolve(code ?? 1);
    });
  });
}

if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], "file:").href) {
  try {
    process.exitCode = await run(process.argv[2]);
  } catch {
    console.error("delivery command failed");
    process.exitCode = 1;
  }
}
