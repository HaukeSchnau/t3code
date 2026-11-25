import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, RunId, type ThreadPlacement } from "@t3tools/contracts";

import { placementWaitOf } from "./placementWait.ts";

const placement: ThreadPlacement = {
  decidedBy: { environmentId: EnvironmentId.make("tower"), label: "tower" },
  environmentId: EnvironmentId.make("dev-hauke"),
  label: "dev-hauke",
  reason: "no machine has room",
  candidates: [],
  decidedAt: "2026-11-24T12:00:00.000Z",
  waitingSince: "2026-11-24T12:00:00.000Z",
};

const runtime = (status: string, activeRunId: string | null = "run-1") =>
  ({ status, activeRunId: activeRunId === null ? null : RunId.make(activeRunId) }) as never;

describe("placementWaitOf", () => {
  it("shows the wait while its run prepares, and cancels that run", () => {
    // The shell's runtime is its active run, and a queued follow-up never is one.
    expect(placementWaitOf({ placement, runtime: runtime("preparing") })).toEqual({
      placement,
      cancelRunId: "run-1",
    });
    expect(placementWaitOf({ placement, runtime: runtime("running") })).toBeNull();
    expect(
      placementWaitOf({
        placement: { ...placement, waitingSince: null },
        runtime: runtime("preparing"),
      }),
    ).toBeNull();
  });
});
