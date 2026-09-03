import { assert, describe, it } from "@effect/vitest";

import { planReplay } from "./ReplayPlanner.ts";

describe("ReplayPlanner", () => {
  it("keeps bounded catch-up on the exact event path", () => {
    assert.deepEqual(
      planReplay(
        { eventCount: 12, payloadBytes: 32_000, truncated: false },
        { maxEvents: 256, maxPayloadBytes: 2_000_000 },
      ),
      { strategy: "events", reason: "bounded" },
    );
  });

  it("switches to a snapshot for a bounded sample with excessive bytes", () => {
    assert.deepEqual(
      planReplay(
        { eventCount: 8, payloadBytes: 2_000_001, truncated: false },
        { maxEvents: 256, maxPayloadBytes: 2_000_000 },
      ),
      { strategy: "snapshot", reason: "payload-bytes" },
    );
  });

  it("bounds structural work for the 1,013-event production-shaped backlog", () => {
    const backlog = Array.from({ length: 1_013 }, (_, index) => ({
      sequence: index + 1,
      payloadBytes: 128,
    }));
    const maxEvents = 256;
    const inspected = backlog.slice(0, maxEvents + 1);
    const probe = {
      eventCount: inspected.length,
      payloadBytes: inspected.reduce((total, event) => total + event.payloadBytes, 0),
      truncated: backlog.length > maxEvents,
    };

    assert.equal(inspected.length, 257);
    assert.equal(backlog.length / inspected.length > 3.9, true);
    assert.deepEqual(planReplay(probe, { maxEvents, maxPayloadBytes: 2_000_000 }), {
      strategy: "snapshot",
      reason: "event-count",
    });
  });
});
