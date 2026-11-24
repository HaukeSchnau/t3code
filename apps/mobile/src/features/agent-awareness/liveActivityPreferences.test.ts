import { beforeEach, vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  MobilePreferencesSaveError,
  MobilePreferencesStore,
} from "../../persistence/mobile-preferences";
import { MobileStorage } from "../../persistence/mobile-storage";
import { setLiveActivityUpdatesEnabled } from "./liveActivityPreferences";
import { updateAgentAwarenessRegistrationPreferences } from "./remoteRegistration";

vi.mock("expo-secure-store", () => ({
  deleteItemAsync: vi.fn(),
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));

vi.mock("./remoteRegistration", () => ({
  updateAgentAwarenessRegistrationPreferences: vi.fn(() => Effect.void),
}));

const saveLocalPreference = vi.fn<
  (enabled: boolean) => Effect.Effect<void, MobilePreferencesSaveError>
>(() => Effect.void);

// The registration module is mocked, so its persistence services are never read.
const withPersistence = Effect.provide(
  Layer.mergeAll(
    Layer.succeed(MobileStorage, null as never),
    Layer.succeed(MobilePreferencesStore, null as never),
  ),
);

describe("liveActivityPreferences", () => {
  beforeEach(() => vi.clearAllMocks());

  it.effect("updates the paired environment registration and saves the preference", () =>
    Effect.gen(function* () {
      yield* setLiveActivityUpdatesEnabled({
        saveLocalPreference,
        enabled: true,
        previousEnabled: false,
      });
      expect(updateAgentAwarenessRegistrationPreferences).toHaveBeenCalledWith({
        liveActivitiesEnabled: true,
      });
      expect(saveLocalPreference).toHaveBeenCalledWith(true);
    }).pipe(withPersistence),
  );

  it.effect("restores the previous value when registration fails", () => {
    vi.mocked(updateAgentAwarenessRegistrationPreferences)
      .mockImplementationOnce(() => Effect.die("offline"))
      .mockImplementationOnce(() => Effect.void);

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        setLiveActivityUpdatesEnabled({
          saveLocalPreference,
          enabled: false,
          previousEnabled: true,
        }),
      );
      expect(exit._tag).toBe("Failure");
      expect(updateAgentAwarenessRegistrationPreferences).toHaveBeenNthCalledWith(1, {
        liveActivitiesEnabled: false,
      });
      expect(updateAgentAwarenessRegistrationPreferences).toHaveBeenNthCalledWith(2, {
        liveActivitiesEnabled: true,
      });
      expect(saveLocalPreference).not.toHaveBeenCalled();
    }).pipe(withPersistence);
  });

  it.effect("restores the device preference when the device cannot save the setting", () => {
    saveLocalPreference.mockImplementationOnce(() =>
      Effect.fail(new MobilePreferencesSaveError({ cause: new Error("storage full") })),
    );

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        setLiveActivityUpdatesEnabled({
          saveLocalPreference,
          enabled: true,
          previousEnabled: false,
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(updateAgentAwarenessRegistrationPreferences).toHaveBeenLastCalledWith({
        liveActivitiesEnabled: false,
      });
    }).pipe(withPersistence);
  });
});
