#!/usr/bin/env node
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli, type CliIo } from "./cli.js";

async function findRepositoryRoot(start: string): Promise<string> {
  let current = start;
  for (;;) {
    try {
      await access(join(current, "schemas", "delivery-contract.schema.json"));
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) throw new Error("platform root not found");
      current = parent;
    }
  }
}

const io: CliIo = {
  writeStdout(value) {
    process.stdout.write(value);
  },
  writeStderr(value) {
    process.stderr.write(value);
  },
};

const root = await findRepositoryRoot(dirname(fileURLToPath(import.meta.url)));
process.exitCode = await runCli(process.argv.slice(2), io, root);
