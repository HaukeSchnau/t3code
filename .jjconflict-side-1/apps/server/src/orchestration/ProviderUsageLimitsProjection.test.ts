import {
  EventId,
  ProviderDriverKind,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { usageLimitsFromRuntimeEvent } from "./ProviderUsageLimitsProjection.ts";

function event(rateLimits: unknown): ProviderRuntimeEvent {
  return {
    type: "account.rate-limits.updated",
    eventId: EventId.make("rate-limits"),
    provider: ProviderDriverKind.make("codex"),
    createdAt: "2026-01-01T00:00:00.000Z",
    threadId: ThreadId.make("thread-1"),
    payload: { rateLimits },
  };
}

describe("usageLimitsFromRuntimeEvent", () => {
  it("unwraps nested snapshots and normalizes reset timestamps", () => {
    expect(
      usageLimitsFromRuntimeEvent(
        event({
          rateLimits: {
            limitId: "codex",
            credits: { balance: "12.50", hasCredits: true, unlimited: false },
            primary: {
              usedPercent: 40,
              resetsAt: 1_746_052_800,
              windowDurationMins: 300,
            },
          },
        }),
      ),
    ).toMatchObject({
      limitId: "codex",
      updatedAt: "2026-01-01T00:00:00.000Z",
      credits: { balance: "12.50", hasCredits: true, unlimited: false },
      primary: {
        usedPercent: 40,
        resetsAt: "2025-04-30T22:40:00.000Z",
        windowDurationMins: 300,
      },
    });
  });

  it("prefers a nonzero individual spend limit over an empty secondary window", () => {
    expect(
      usageLimitsFromRuntimeEvent(
        event({
          secondary: { usedPercent: 0, resetsAt: "2026-01-08T00:00:00.000Z" },
          individualLimit: { remainingPercent: 73, resetsAt: 1_767_830_400 },
        }),
      )?.secondary,
    ).toEqual({
      usedPercent: 27,
      resetsAt: "2026-01-08T00:00:00.000Z",
      windowDurationMins: null,
    });
  });

  it("preserves keyed provider windows with labels", () => {
    expect(
      usageLimitsFromRuntimeEvent(
        event({
          limitId: "claude",
          primary: {
            key: "session",
            label: "Current session",
            usedPercent: 97,
            resetsAt: "2026-08-21T17:00:00.000Z",
            windowDurationMins: 300,
          },
          secondary: null,
          windows: [
            {
              key: "weekly-scoped:fable",
              label: "Fable",
              usedPercent: 0,
              resetsAt: null,
              windowDurationMins: 10080,
            },
          ],
        }),
      ),
    ).toMatchObject({
      limitId: "claude",
      primary: {
        key: "session",
        label: "Current session",
      },
      windows: [
        {
          key: "weekly-scoped:fable",
          label: "Fable",
          usedPercent: 0,
        },
      ],
    });
  });
});
