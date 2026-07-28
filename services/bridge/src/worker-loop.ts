export interface WorkerWait {
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export class SystemWorkerWait implements WorkerWait {
  async wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const timeout = setTimeout(resolve, milliseconds);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timeout);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }
}

export interface WorkerLoopOptions {
  readonly signal: AbortSignal;
  readonly pollIntervalMilliseconds: number;
  readonly runOnce: () => Promise<string>;
  readonly wait: WorkerWait;
  readonly onPause?: (reasonCode: "repeated_infrastructure_failure") => void;
}

export async function runWorkerLoop(
  options: WorkerLoopOptions,
): Promise<"stopped" | "paused"> {
  if (
    !Number.isInteger(options.pollIntervalMilliseconds) ||
    options.pollIntervalMilliseconds < 100 || options.pollIntervalMilliseconds > 60_000
  ) throw new Error("invalid worker poll interval");

  let consecutiveInfrastructureFailures = 0;
  while (!options.signal.aborted) {
    let outcome: string;
    try {
      outcome = await options.runOnce();
      consecutiveInfrastructureFailures = 0;
    } catch {
      consecutiveInfrastructureFailures += 1;
      if (consecutiveInfrastructureFailures >= 2) {
        options.onPause?.("repeated_infrastructure_failure");
        return "paused";
      }
      outcome = "idle";
    }

    if (options.signal.aborted) break;
    if (outcome === "idle" || consecutiveInfrastructureFailures > 0) {
      try {
        await options.wait.wait(options.pollIntervalMilliseconds, options.signal);
      } catch {
        if (!options.signal.aborted) throw new Error("worker wait failed");
      }
    }
  }
  return "stopped";
}
