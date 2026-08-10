import { beforeEach, vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { setLiveActivityUpdatesEnabled } from "./liveActivityPreferences";
import { updateAgentAwarenessRegistrationPreferences } from "./remoteRegistration";

vi.mock("./remoteRegistration", () => ({
  updateAgentAwarenessRegistrationPreferences: vi.fn(() => Effect.void),
}));

describe("liveActivityPreferences", () => {
  beforeEach(() => vi.clearAllMocks());

  it.effect("updates the paired environment registration", () =>
    Effect.gen(function* () {
      yield* setLiveActivityUpdatesEnabled({ enabled: true, previousEnabled: false });
      expect(updateAgentAwarenessRegistrationPreferences).toHaveBeenCalledWith({
        liveActivitiesEnabled: true,
      });
    }),
  );

  it.effect("restores the previous value when registration fails", () => {
    vi.mocked(updateAgentAwarenessRegistrationPreferences)
      .mockImplementationOnce(() => Effect.fail(new Error("offline")))
      .mockImplementationOnce(() => Effect.void);

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        setLiveActivityUpdatesEnabled({ enabled: false, previousEnabled: true }),
      );
      expect(exit._tag).toBe("Failure");
      expect(updateAgentAwarenessRegistrationPreferences).toHaveBeenNthCalledWith(1, {
        liveActivitiesEnabled: false,
      });
      expect(updateAgentAwarenessRegistrationPreferences).toHaveBeenNthCalledWith(2, {
        liveActivitiesEnabled: true,
      });
    });
  });
});
