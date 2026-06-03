import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
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
});
