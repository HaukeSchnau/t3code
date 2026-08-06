import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  forgetPendingThreadCreation,
  getPendingThreadCreation,
  makePendingThreadRouteParams,
  rememberPendingThreadCreation,
  resolveThreadRoutePresentation,
} from "./pendingThreadNavigation";

describe("pending thread navigation", () => {
  it("routes with the identity frozen into the queued command", () => {
    expect(
      makePendingThreadRouteParams({
        environmentId: EnvironmentId.make("environment-1"),
        threadId: ThreadId.make("thread-from-command"),
        text: "Restore thread opening after durable acceptance",
      }),
    ).toEqual({
      environmentId: "environment-1",
      threadId: "thread-from-command",
    });
  });

  it("retains and releases the pending handoff without changing route params", () => {
    const message = {
      environmentId: EnvironmentId.make("environment-handoff"),
      threadId: ThreadId.make("thread-handoff"),
      text: "Keep the pending screen visible",
    };

    rememberPendingThreadCreation(message);
    expect(
      getPendingThreadCreation(String(message.environmentId), String(message.threadId)),
    ).toEqual({ title: "Keep the pending screen visible" });

    forgetPendingThreadCreation(String(message.environmentId), String(message.threadId));
    expect(
      getPendingThreadCreation(String(message.environmentId), String(message.threadId)),
    ).toBeNull();
  });

  it("hands a pending route over to the matching server shell", () => {
    expect(
      resolveThreadRoutePresentation({
        hasMatchingThread: true,
        pendingCreation: true,
        stillHydrating: false,
      }),
    ).toBe("thread");
  });

  it("keeps the locally accepted route visible until its shell arrives", () => {
    expect(
      resolveThreadRoutePresentation({
        hasMatchingThread: false,
        pendingCreation: true,
        stillHydrating: false,
      }),
    ).toBe("pending-creation");
  });

  it("preserves ordinary loading and unavailable states for non-pending routes", () => {
    expect(
      resolveThreadRoutePresentation({
        hasMatchingThread: false,
        pendingCreation: false,
        stillHydrating: true,
      }),
    ).toBe("loading");
    expect(
      resolveThreadRoutePresentation({
        hasMatchingThread: false,
        pendingCreation: false,
        stillHydrating: false,
      }),
    ).toBe("unavailable");
  });
});
