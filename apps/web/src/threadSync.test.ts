import { describe, expect, it } from "vite-plus/test";

import { resolveThreadSyncPhase } from "./threadSync";

describe("resolveThreadSyncPhase", () => {
  it("loads when only shell data is available", () => {
    expect(
      resolveThreadSyncPhase({
        detailExists: false,
        shellExists: true,
        status: "synchronizing",
      }),
    ).toBe("loading");
  });

  it.each(["cached", "synchronizing"] as const)(
    "keeps %s detail visible without a foreground sync phase",
    (status) => {
      expect(
        resolveThreadSyncPhase({
          detailExists: true,
          shellExists: true,
          status,
        }),
      ).toBeNull();
    },
  );

  it("does not report a sync phase without a shell or after going live", () => {
    expect(
      resolveThreadSyncPhase({
        detailExists: false,
        shellExists: false,
        status: "empty",
      }),
    ).toBeNull();
    expect(
      resolveThreadSyncPhase({
        detailExists: true,
        shellExists: true,
        status: "live",
      }),
    ).toBeNull();
  });
});
