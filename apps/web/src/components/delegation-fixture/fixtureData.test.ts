import { describe, expect, it } from "vitest";

import { DELEGATION_FIXTURE_STATES, delegationCountsLabel } from "./fixtureData";

describe("delegation fixture states", () => {
  it("models the review request and settled comparison honestly", () => {
    const running = DELEGATION_FIXTURE_STATES.running;
    const settled = DELEGATION_FIXTURE_STATES.settled;

    expect(delegationCountsLabel(running.counts)).toBe("2 running · 1 needs review");
    expect(running.workers.find((worker) => worker.label === "Claude")?.reviewRequest).toContain(
      "fail loudly",
    );
    expect(delegationCountsLabel(settled.counts)).toBe("3 results");
    expect(settled.workers.map((worker) => worker.result?.verdict)).toEqual([
      "accepted",
      "partial",
      "rejected",
    ]);
    expect(settled.assessment).toContain("Codex's fix is the one to take");
  });
});
