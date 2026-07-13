import type { OrchestrationEvent, OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isShellSummaryActivity, isShellVisibleThreadEvent } from "./shellVisibility.ts";

const eventWithType = (type: OrchestrationEvent["type"]): OrchestrationEvent =>
  ({ type }) as OrchestrationEvent;

const activity = (kind: string, detail?: string): OrchestrationThreadActivity =>
  ({
    kind,
    payload: detail === undefined ? {} : { detail },
  }) as OrchestrationThreadActivity;

describe("shell visibility", () => {
  it("keeps provider progress and unchanged failures out of the shell", () => {
    expect(isShellSummaryActivity(activity("command_output"))).toBe(false);
    expect(isShellSummaryActivity(activity("subagent.thread"))).toBe(false);
    expect(
      isShellSummaryActivity(
        activity("provider.user-input.respond.failed", "temporary transport failure"),
      ),
    ).toBe(false);
  });

  it("publishes approval and user-input lifecycle changes", () => {
    expect(isShellSummaryActivity(activity("approval.requested"))).toBe(true);
    expect(isShellSummaryActivity(activity("approval.resolved"))).toBe(true);
    expect(isShellSummaryActivity(activity("user-input.requested"))).toBe(true);
    expect(isShellSummaryActivity(activity("user-input.resolved"))).toBe(true);
    expect(
      isShellSummaryActivity(
        activity("provider.approval.respond.failed", "Unknown pending approval request: request-1"),
      ),
    ).toBe(true);
  });

  it("distinguishes user messages and lifecycle state from detail-only events", () => {
    expect(
      isShellVisibleThreadEvent({
        type: "thread.message-sent",
        payload: { role: "user", streaming: false },
      } as OrchestrationEvent),
    ).toBe(true);
    expect(
      isShellVisibleThreadEvent({
        type: "thread.message-sent",
        payload: { role: "assistant", streaming: true },
      } as OrchestrationEvent),
    ).toBe(false);
    expect(
      isShellVisibleThreadEvent({
        type: "thread.message-sent",
        payload: { role: "assistant", streaming: false },
      } as OrchestrationEvent),
    ).toBe(true);
    expect(isShellVisibleThreadEvent(eventWithType("thread.session-set"))).toBe(true);
    expect(isShellVisibleThreadEvent(eventWithType("thread.message-queued"))).toBe(false);
    expect(isShellVisibleThreadEvent(eventWithType("thread.turn-start-requested"))).toBe(false);
  });
});
