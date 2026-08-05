import { describe, expect, it } from "vitest";
import {
  complianceView,
  usageView,
  GovernanceViewError,
  type GovernanceResultInput,
} from "./governance-views.js";

const profile = {
  status: "compliant" as const,
  samples: 4,
  wallSeconds: { p50: 120, p95: 200 },
  queueSeconds: { p50: 5, p95: 9 },
  runnerSeconds: { p50: 150, p95: 300 },
  retryRuns: 1,
};

const delivery = {
  status: "compliant" as const,
  fast: profile,
  major: { ...profile, samples: 0, status: "insufficient_data" as const },
  cacheHitRate: { value: 0.75, coverage: "reported" as const },
};

const result: GovernanceResultInput = {
  schemaVersion: 1,
  window: { from: "2026-07-01T00:00:00.000Z", to: "2026-07-30T00:00:00.000Z" },
  status: "compliant",
  scopes: [
    {
      key: "maxbec",
      status: "compliant",
      paperclip: { company: "compliant", controller: "compliant", lifecycles: "compliant" },
      delivery,
    },
    {
      key: "edilio",
      status: "attention",
      paperclip: { company: "compliant", controller: "drift", lifecycles: "compliant" },
      delivery: { ...delivery, status: "attention" },
    },
  ],
  pooled: delivery,
};

describe("compliance view", () => {
  it("reports each scope's Paperclip compliance without repeating delivery metrics", () => {
    const view = complianceView(result);

    expect(view).toEqual({
      schemaVersion: 1,
      status: "attention",
      window: result.window,
      scopes: [
        { key: "maxbec", status: "compliant", drift: [] },
        { key: "edilio", status: "attention", drift: ["controller"] },
      ],
    });
  });

  it("names every drifted Paperclip dimension", () => {
    const view = complianceView({
      ...result,
      scopes: [{
        key: "navigaite",
        status: "attention",
        paperclip: { company: "drift", controller: "drift", lifecycles: "drift" },
        delivery,
      }],
    });

    expect(view.scopes[0]?.drift).toEqual(["company", "controller", "lifecycles"]);
  });

  it("rejects a result that is not a governance result", () => {
    expect(() => complianceView({ ...result, schemaVersion: 2 as 1 })).toThrow(GovernanceViewError);
  });
});

describe("usage view", () => {
  const budget = {
    version: 1 as const,
    pool: "flama-ci-budget",
    targets: {
      fast: { p50WallMinutes: 3, p95WallMinutes: 6, runnerMinutesPerMainPr: 8 },
      major: { p50WallMinutes: 6, p95WallMinutes: 12, runnerMinutesPerPromotion: 20 },
    },
  };

  it("reports pooled usage against the pooled budget targets", () => {
    const view = usageView(result, budget);

    expect(view).toMatchObject({
      schemaVersion: 1,
      pool: "flama-ci-budget",
      window: result.window,
      cacheHitRate: { value: 0.75, coverage: "reported" },
      profiles: {
        fast: {
          samples: 4,
          wallSecondsP50: 120,
          wallSecondsP95: 200,
          runnerSecondsP95: 300,
          targetWallSecondsP50: 180,
          targetWallSecondsP95: 360,
          targetRunnerSeconds: 480,
          withinTarget: true,
        },
      },
    });
  });

  it("marks a profile outside target when a measured percentile reaches its limit", () => {
    const view = usageView({
      ...result,
      pooled: { ...delivery, fast: { ...profile, wallSeconds: { p50: 200, p95: 200 } } },
    }, budget);

    expect(view.profiles.fast?.withinTarget).toBe(false);
  });

  it("reports a profile with no samples as unmeasured rather than compliant", () => {
    const view = usageView(result, budget);

    expect(view.profiles.major).toMatchObject({ samples: 0, withinTarget: null });
  });

  it("rejects a budget policy of an unsupported version", () => {
    expect(() => usageView(result, { ...budget, version: 2 as 1 })).toThrow(GovernanceViewError);
  });
});
