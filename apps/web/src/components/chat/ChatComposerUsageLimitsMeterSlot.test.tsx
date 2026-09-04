import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderDriverKind } from "@t3tools/contracts";

import {
  deriveDisplayedUsageLimitsSnapshot,
  type UsageLimitsSnapshot,
} from "../../lib/usageLimits";
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

  it("renders Codex snapshots that only expose named windows", () => {
    const html = renderToStaticMarkup(
      <ComposerUsageLimitsMeterSlot
        compact={false}
        selectedProvider={ProviderDriverKind.make("codex")}
        activeUsageLimits={{
          ...usageLimits,
          primary: null,
          windows: [
            {
              label: "Weekly",
              usedPercent: 93,
              resetsAt: "2099-01-08T05:00:00.000Z",
              windowDurationMins: 10080,
            },
          ],
        }}
      />,
    );

    expect(html).toContain("1w");
    expect(html).toContain("93%");
  });

  it("renders Claude usage limits", () => {
    const claudeUsageLimits: UsageLimitsSnapshot = {
      ...usageLimits,
      limitId: "claude",
      limitName: "Claude usage",
      planType: null,
      primary: {
        key: "session",
        label: "Current session",
        usedPercent: 96,
        resetsAt: "2099-01-01T05:00:00.000Z",
        windowDurationMins: 300,
      },
      windows: [
        {
          key: "session",
          label: "Current session",
          usedPercent: 96,
          resetsAt: "2099-01-01T05:00:00.000Z",
          windowDurationMins: 300,
        },
        {
          key: "weekly-all",
          label: "All models",
          usedPercent: 13,
          resetsAt: "2099-01-08T05:00:00.000Z",
          windowDurationMins: 10080,
        },
        {
          key: "weekly-scoped:fable",
          label: "Fable",
          usedPercent: 0,
          resetsAt: null,
          windowDurationMins: 10080,
        },
      ],
    };
    const html = renderToStaticMarkup(
      <ComposerUsageLimitsMeterSlot
        compact={false}
        selectedProvider={ProviderDriverKind.make("claudeAgent")}
        activeUsageLimits={claudeUsageLimits}
      />,
    );

    expect(html).toContain("Claude usage");
    expect(html).toContain("96%");
  });

  it("hides usage limits for unsupported providers", () => {
    const html = renderToStaticMarkup(
      <ComposerUsageLimitsMeterSlot
        compact={false}
        selectedProvider={ProviderDriverKind.make("cursor")}
        activeUsageLimits={usageLimits}
      />,
    );

    expect(html).toBe("");
  });

  it("renders GLM Coding Plan usage for the matching OpenCode model", () => {
    const glmUsageLimits: UsageLimitsSnapshot = {
      ...usageLimits,
      limitId: "zai-coding-plan",
      limitName: "GLM Coding Plan",
      planType: "Pro",
      primary: {
        key: "zai:tokens:3:5",
        label: "Current window",
        usedPercent: 6,
        resetsAt: "2099-01-01T05:00:00.000Z",
        windowDurationMins: 300,
      },
      windows: [
        {
          key: "zai:tokens:3:5",
          label: "Current window",
          usedPercent: 6,
          resetsAt: "2099-01-01T05:00:00.000Z",
          windowDurationMins: 300,
        },
        {
          key: "zai:mcp:5:1",
          label: "MCP quota",
          usedPercent: 0,
          resetsAt: "2099-02-01T05:00:00.000Z",
          windowDurationMins: 44_640,
        },
      ],
    };
    const html = renderToStaticMarkup(
      <ComposerUsageLimitsMeterSlot
        compact={false}
        selectedProvider={ProviderDriverKind.make("opencode")}
        selectedModel="zai-coding-plan/glm-5.2"
        activeUsageLimits={glmUsageLimits}
      />,
    );

    expect(html).toContain("GLM Coding Plan");
    expect(html).toContain("6%");
    expect(
      deriveDisplayedUsageLimitsSnapshot(glmUsageLimits)?.windows.map((window) => window.label),
    ).toContain("MCP quota");
  });

  it("hides GLM usage for a different OpenCode provider or model family", () => {
    const glmUsageLimits: UsageLimitsSnapshot = {
      ...usageLimits,
      limitId: "zai-coding-plan",
      limitName: "GLM Coding Plan",
    };
    const mismatchedProvider = renderToStaticMarkup(
      <ComposerUsageLimitsMeterSlot
        compact={false}
        selectedProvider={ProviderDriverKind.make("opencode")}
        selectedModel="other-zai/glm-5.2"
        activeUsageLimits={glmUsageLimits}
      />,
    );
    const nonGlmModel = renderToStaticMarkup(
      <ComposerUsageLimitsMeterSlot
        compact={false}
        selectedProvider={ProviderDriverKind.make("opencode")}
        selectedModel="zai-coding-plan/deepseek-v3"
        activeUsageLimits={glmUsageLimits}
      />,
    );

    expect(mismatchedProvider).toBe("");
    expect(nonGlmModel).toBe("");
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
    expect(html).toContain("Uses observed portions of 3 recent windows");
    expect(html).toContain("Could run out up to");
    expect(html).toContain("Likely to run out around");
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

    expect(html).toContain("~45m early");
    expect(html).toContain("Early estimate: may run out around");
    expect(html).toContain("about 45m before reset.");
  });

  it("describes a historical depletion range as time before reset", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-23T12:30:00.000Z"));
    const currentResetMs = Date.parse("2026-03-23T15:00:00.000Z");
    const durationMs = 5 * 60 * 60 * 1000;
    const atRiskUsageLimits: UsageLimitsSnapshot = {
      ...usageLimits,
      primary: {
        usedPercent: 60,
        resetsAt: new Date(currentResetMs).toISOString(),
        windowDurationMins: 300,
      },
      updatedAt: "2026-03-23T12:30:00.000Z",
      history: [120, 130, 140].map((finalUsed, index) => {
        const resetMs = currentResetMs - (index + 1) * 24 * 60 * 60 * 1000;
        return {
          resetsAt: new Date(resetMs).toISOString(),
          windowDurationMins: 300,
          points: [
            {
              observedAt: new Date(resetMs - durationMs / 2).toISOString(),
              usedPercent: 60,
            },
            { observedAt: new Date(resetMs - 60 * 1000).toISOString(), usedPercent: finalUsed },
          ],
        };
      }),
    };

    const html = renderToStaticMarkup(
      <ComposerUsageLimitsMeterSlot
        compact
        selectedProvider={ProviderDriverKind.make("codex")}
        activeUsageLimits={atRiskUsageLimits}
      />,
    );

    expect(html).toContain("~1h early");
    expect(html).toContain("Recent windows suggest 45m to 1h before reset.");
  });

  it("labels stale, expired observations as awaiting a refresh", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-23T12:06:00.000Z"));
    const staleUsageLimits: UsageLimitsSnapshot = {
      ...usageLimits,
      limitId: "claude",
      limitName: "Claude usage",
      primary: {
        usedPercent: 45,
        resetsAt: "2026-03-23T12:03:00.000Z",
        windowDurationMins: 300,
      },
      updatedAt: "2026-03-23T11:55:00.000Z",
    };

    const html = renderToStaticMarkup(
      <ComposerUsageLimitsMeterSlot
        compact={false}
        selectedProvider={ProviderDriverKind.make("claudeAgent")}
        activeUsageLimits={staleUsageLimits}
      />,
    );

    expect(html).toContain("Updated 11m ago; may be stale");
    expect(html).toContain("previous window ended; update pending");
    expect(html).toContain("update pending");
    expect(html).not.toContain("Resets in Expired");
  });
});
