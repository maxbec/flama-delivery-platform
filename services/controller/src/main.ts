import { runControllerRuntime, ControllerRuntimeError } from "./controller-runtime.js";

try {
  const result = await runControllerRuntime(process.env, process.cwd());
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const code = error instanceof ControllerRuntimeError ? error.code : "controller_runtime_failed";
  process.stderr.write(`${JSON.stringify({ error: { code }, ok: false })}\n`);
  process.exitCode = 2;
}
