import { describe, expect, it } from "vite-plus/test";

import { resolveThreadSyncPhase } from "./threadSync";

describe("resolveThreadSyncPhase", () => {
  it("loads when only shell data is available", () => {
    expect(
      resolveThreadSyncPhase({
        detailExists: false,
        shellExists: true,
        status: "synchronizing",
        hasError: false,
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
          hasError: false,
        }),
      ).toBeNull();
    },
  );

  it("reports a failed sync instead of syncing over cached messages", () => {
    expect(
      resolveThreadSyncPhase({
        detailExists: true,
        shellExists: true,
        status: "cached",
        hasError: true,
      }),
    ).toBe("failed");
    expect(
      resolveThreadSyncPhase({
        detailExists: false,
        shellExists: true,
        status: "synchronizing",
        hasError: true,
      }),
    ).toBe("loading");
  });

  it("does not report a sync phase without a shell or after going live", () => {
    expect(
      resolveThreadSyncPhase({
        detailExists: false,
        shellExists: false,
        status: "empty",
        hasError: false,
      }),
    ).toBeNull();
    expect(
      resolveThreadSyncPhase({
        detailExists: true,
        shellExists: true,
        status: "live",
        hasError: false,
      }),
    ).toBeNull();
  });
});
