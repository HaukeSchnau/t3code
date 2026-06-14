import type { OrchestrationEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isThreadDetailEvent } from "./ws.ts";

const eventWithType = (type: OrchestrationEvent["type"]): OrchestrationEvent =>
  ({ type }) as OrchestrationEvent;

describe("isThreadDetailEvent", () => {
  it("streams queued message lifecycle events to active thread subscribers", () => {
    expect(isThreadDetailEvent(eventWithType("thread.message-queued"))).toBe(true);
    expect(isThreadDetailEvent(eventWithType("thread.queued-message-deleted"))).toBe(true);
    expect(isThreadDetailEvent(eventWithType("thread.queued-message-dispatched"))).toBe(true);
  });

  it("keeps non-detail orchestration events out of thread detail streams", () => {
    expect(isThreadDetailEvent(eventWithType("thread.turn-start-requested"))).toBe(false);
  });
});
