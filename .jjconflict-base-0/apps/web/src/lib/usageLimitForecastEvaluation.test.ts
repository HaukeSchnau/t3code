import { describe, expect, it } from "vitest";

import { evaluateUsageLimitForecastHistory } from "./usageLimitForecastEvaluation";

const hourMs = 60 * 60 * 1000;

describe("evaluateUsageLimitForecastHistory", () => {
  it("walks forward without using the window under evaluation as history", () => {
    const resets = ["2026-08-20T17:00:00.000Z", "2026-08-21T17:00:00.000Z"];
    const history = resets.map((resetsAt) => {
      const resetMs = Date.parse(resetsAt);
      return {
        windowKey: "session",
        resetsAt,
        windowDurationMins: 300,
        points: [
          { observedAt: new Date(resetMs - 4 * hourMs).toISOString(), usedPercent: 20 },
          { observedAt: new Date(resetMs - 2 * hourMs).toISOString(), usedPercent: 60 },
          { observedAt: new Date(resetMs).toISOString(), usedPercent: 100 },
        ],
      };
    });

    const report = evaluateUsageLimitForecastHistory(history, Date.parse("2026-08-22T00:00:00Z"));

    expect(report.groups).toHaveLength(1);
    expect(report.overall.evaluatedWindowCount).toBe(2);
    expect(report.overall.regularized.predictionCount).toBe(4);
    expect(report.overall.current.predictionCount).toBe(4);
    expect(report.overall.regularized.meanAbsoluteError).not.toBeNull();
    expect(report.overall.current.riskDecisionAccuracy).toBe(1);

    const changedFuture = structuredClone(history);
    changedFuture[1]!.points[2]!.usedPercent = 140;
    const changedReport = evaluateUsageLimitForecastHistory(
      changedFuture,
      Date.parse("2026-08-22T00:00:00Z"),
    );
    expect(changedReport.overall.current.meanAbsoluteJump).toBe(
      report.overall.current.meanAbsoluteJump,
    );
  });

  it("separates early resets, active windows, and unobserved completions", () => {
    const history = [
      {
        windowKey: "session",
        resetsAt: "2026-08-20T17:00:00.000Z",
        windowDurationMins: 300,
        points: [{ observedAt: "2026-08-20T13:00:00.000Z", usedPercent: 10 }],
      },
      {
        windowKey: "session",
        resetsAt: "2026-08-20T19:00:00.000Z",
        windowDurationMins: 300,
        points: [{ observedAt: "2026-08-20T14:00:00.000Z", usedPercent: 2 }],
      },
      {
        windowKey: "weekly-all",
        resetsAt: "2026-08-21T00:00:00.000Z",
        windowDurationMins: 10080,
        points: [{ observedAt: "2026-08-20T12:00:00.000Z", usedPercent: 20 }],
      },
      {
        windowKey: "weekly-all",
        resetsAt: "2026-08-28T00:00:00.000Z",
        windowDurationMins: 10080,
        points: [{ observedAt: "2026-08-21T00:00:00.000Z", usedPercent: 1 }],
      },
    ];

    const report = evaluateUsageLimitForecastHistory(history, Date.parse("2026-08-22T00:00:00Z"));
    const session = report.groups.find((group) => group.windowKey === "session");
    const weekly = report.groups.find((group) => group.windowKey === "weekly-all");

    expect(session).toMatchObject({
      earlyResetWindowCount: 1,
      unobservedCompletionWindowCount: 1,
    });
    expect(weekly).toMatchObject({
      unobservedCompletionWindowCount: 1,
      activeWindowCount: 1,
    });
    expect(report.overall.evaluatedWindowCount).toBe(0);
  });

  it("reports whether history beats the regularized baseline", () => {
    const history = Array.from({ length: 4 }, (_, index) => {
      const resetMs = Date.parse("2026-08-20T17:00:00.000Z") + index * 24 * hourMs;
      return {
        windowKey: "session",
        resetsAt: new Date(resetMs).toISOString(),
        windowDurationMins: 300,
        points: [
          { observedAt: new Date(resetMs - 4 * hourMs).toISOString(), usedPercent: 5 },
          { observedAt: new Date(resetMs - 2 * hourMs).toISOString(), usedPercent: 20 },
          { observedAt: new Date(resetMs).toISOString(), usedPercent: 40 },
        ],
      };
    });

    const report = evaluateUsageLimitForecastHistory(history, Date.parse("2026-08-25T00:00:00Z"));

    expect(report.overall.meanAbsoluteErrorImprovement).not.toBeNull();
    expect(report.overall.meanAbsoluteErrorImprovementPercent).not.toBeNull();
    expect(report.overall.current.meanAbsoluteJump).not.toBeNull();
  });
});
