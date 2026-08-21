import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderDriverKind } from "@t3tools/contracts";

import { type UsageLimitsSnapshot } from "../../lib/usageLimits";
import { ComposerUsageLimitsMeterSlot } from "./ChatComposer";

const usageLimits: UsageLimitsSnapshot = {
  limitId: "codex",
  limitName: "Codex usage",
  planType: "plus",
  rateLimitReachedType: null,
  credits: null,
  updatedAt: "2026-06-03T10:00:00.000Z",
  primary: {
    usedPercent: 20,
    resetsAt: "2099-01-01T05:00:00.000Z",
    windowDurationMins: 300,
  },
  secondary: null,
};

describe("ComposerUsageLimitsMeterSlot", () => {
  afterEach(() => vi.useRealTimers());

  it("renders usage limits for Codex", () => {
    const html = renderToStaticMarkup(
      <ComposerUsageLimitsMeterSlot
        compact={false}
        selectedProvider={ProviderDriverKind.make("codex")}
        activeUsageLimits={usageLimits}
      />,
    );

    expect(html).toContain("Codex usage");
    expect(html).toContain("20%");
  });

  it("hides usage limits for non-Codex providers", () => {
    const html = renderToStaticMarkup(
      <ComposerUsageLimitsMeterSlot
        compact={false}
        selectedProvider={ProviderDriverKind.make("claudeAgent")}
        activeUsageLimits={usageLimits}
      />,
    );

    expect(html).toBe("");
  });

  it("explains forecasts learned from recent windows", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T10:10:00.000Z"));
    const adaptiveUsageLimits: UsageLimitsSnapshot = {
      ...usageLimits,
      primary: {
        usedPercent: 5,
        resetsAt: "2026-08-20T08:15:00.000Z",
        windowDurationMins: 10080,
      },
      updatedAt: "2026-08-13T10:10:00.000Z",
      history: [80, 100, 92].map((finalUsed, index) => {
        const resetMs = Date.parse("2026-08-13T08:15:00.000Z") - index * 7 * 24 * 60 * 60 * 1000;
        return {
          resetsAt: new Date(resetMs).toISOString(),
          windowDurationMins: 10080,
          points: [
            {
              observedAt: new Date(
                resetMs - 7 * 24 * 60 * 60 * 1000 + 115 * 60 * 1000,
              ).toISOString(),
              usedPercent: 5,
            },
            { observedAt: new Date(resetMs - 60 * 1000).toISOString(), usedPercent: finalUsed },
          ],
        };
      }),
    };

    const html = renderToStaticMarkup(
      <ComposerUsageLimitsMeterSlot
        compact={false}
        selectedProvider={ProviderDriverKind.make("codex")}
        activeUsageLimits={adaptiveUsageLimits}
      />,
    );

    expect(html).toContain("forecast");
    expect(html).toContain("Based on 3 recent windows");
    expect(html).toContain("Typical range");
    expect(html).toContain("Expected to last until reset");
  });

  it("shows depletion timing in the compact meter when usage is at risk", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-23T12:30:00.000Z"));
    const atRiskUsageLimits: UsageLimitsSnapshot = {
      ...usageLimits,
      primary: {
        usedPercent: 60,
        resetsAt: "2026-03-23T15:00:00.000Z",
        windowDurationMins: 300,
      },
      updatedAt: "2026-03-23T12:30:00.000Z",
    };

    const html = renderToStaticMarkup(
      <ComposerUsageLimitsMeterSlot
        compact
        selectedProvider={ProviderDriverKind.make("codex")}
        activeUsageLimits={atRiskUsageLimits}
      />,
    );

    expect(html).toContain("out ~1h45m");
    expect(html).toContain("Early estimate: may run out in about 1h 45m");
  });
});
