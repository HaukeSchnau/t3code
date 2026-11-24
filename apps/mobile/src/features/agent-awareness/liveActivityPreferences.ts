import * as Effect from "effect/Effect";

import { updateAgentAwarenessRegistrationPreferences } from "./remoteRegistration";

export const setLiveActivityUpdatesEnabled = Effect.fn("setLiveActivityUpdatesEnabled")(function* <
  SaveError,
>(input: {
  readonly enabled: boolean;
  readonly previousEnabled: boolean;
  readonly saveLocalPreference: (enabled: boolean) => Effect.Effect<unknown, SaveError>;
}) {
  const updateEnvironmentPreference = Effect.fn("updateEnvironmentPreference")(function* () {
    yield* updateAgentAwarenessRegistrationPreferences({
      liveActivitiesEnabled: input.enabled,
    });

    // Saved here so a device that cannot keep the setting restores its registration too.
    yield* input.saveLocalPreference(input.enabled);
  });

  return yield* updateEnvironmentPreference().pipe(
    Effect.onError(() =>
      updateAgentAwarenessRegistrationPreferences({
        liveActivitiesEnabled: input.previousEnabled,
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not restore Live Activity device preference.", cause),
        ),
      ),
    ),
  );
});
