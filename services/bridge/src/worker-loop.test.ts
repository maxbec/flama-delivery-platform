import { describe, expect, it, vi } from "vitest";
import { runWorkerLoop, type WorkerWait } from "./worker-loop.js";

const immediateWait: WorkerWait = {
  async wait(_milliseconds, signal) {
    if (signal.aborted) throw signal.reason;
  },
};

describe("bounded worker loop", () => {
  it("polls again after idle work and stops on cancellation", async () => {
    const controller = new AbortController();
    const runOnce = vi.fn(async () => {
      if (runOnce.mock.calls.length === 2) controller.abort();
      return "idle" as const;
    });

    await expect(
      runWorkerLoop({
        signal: controller.signal,
        pollIntervalMilliseconds: 100,
        runOnce,
        wait: immediateWait,
      }),
    ).resolves.toBe("stopped");
    expect(runOnce).toHaveBeenCalledTimes(2);
  });

  it("allows one transient infrastructure retry then pauses with a reason code", async () => {
    const paused: string[] = [];
    const runOnce = vi.fn(async () => {
      throw new Error("private infrastructure detail");
    });

    await expect(
      runWorkerLoop({
        signal: new AbortController().signal,
        pollIntervalMilliseconds: 100,
        runOnce,
        wait: immediateWait,
        onPause(reasonCode) { paused.push(reasonCode); },
      }),
    ).resolves.toBe("paused");
    expect(runOnce).toHaveBeenCalledTimes(2);
    expect(paused).toEqual(["repeated_infrastructure_failure"]);
    expect(JSON.stringify(paused)).not.toContain("private infrastructure detail");
  });

  it("pauses after two handled infrastructure-failure outcomes", async () => {
    const paused: string[] = [];
    const runOnce = vi.fn(async () => "infrastructure_failed" as const);

    await expect(
      runWorkerLoop({
        signal: new AbortController().signal,
        pollIntervalMilliseconds: 100,
        runOnce,
        wait: immediateWait,
        onPause(reasonCode) { paused.push(reasonCode); },
      }),
    ).resolves.toBe("paused");
    expect(runOnce).toHaveBeenCalledTimes(2);
    expect(paused).toEqual(["repeated_infrastructure_failure"]);
  });

  it("does not erase an infrastructure-failure streak merely because the queue is idle", async () => {
    const outcomes = ["infrastructure_failed", "idle", "infrastructure_failed"] as const;
    let index = 0;
    const runOnce = vi.fn(async () => outcomes[index++]!);

    await expect(
      runWorkerLoop({
        signal: new AbortController().signal,
        pollIntervalMilliseconds: 100,
        runOnce,
        wait: immediateWait,
      }),
    ).resolves.toBe("paused");
    expect(runOnce).toHaveBeenCalledTimes(3);
  });

  it("resets the failure counter after a successful operation", async () => {
    const controller = new AbortController();
    const outcomes = ["throw", "completed", "throw", "completed"] as const;
    let index = 0;
    const runOnce = vi.fn(async () => {
      const outcome = outcomes[index++]!;
      if (outcome === "throw") throw new Error("transient");
      if (index === outcomes.length) controller.abort();
      return outcome;
    });

    await expect(
      runWorkerLoop({
        signal: controller.signal,
        pollIntervalMilliseconds: 100,
        runOnce,
        wait: immediateWait,
      }),
    ).resolves.toBe("stopped");
    expect(runOnce).toHaveBeenCalledTimes(4);
  });
});
