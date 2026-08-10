import * as Effect from "effect/Effect";

import { updateAgentAwarenessRegistrationPreferences } from "./remoteRegistration";

export const setLiveActivityUpdatesEnabled = Effect.fn("setLiveActivityUpdatesEnabled")(
  function* (input: { readonly enabled: boolean; readonly previousEnabled: boolean }) {
    const updateEnvironmentPreference = Effect.fn("updateEnvironmentPreference")(function* (
      enabled: boolean,
    ) {
      yield* updateAgentAwarenessRegistrationPreferences({
        liveActivitiesEnabled: enabled,
      });
    });

    const restoreEnvironmentPreference = Effect.fn("restoreEnvironmentPreference")(function* () {
      yield* updateAgentAwarenessRegistrationPreferences({
        liveActivitiesEnabled: input.previousEnabled,
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not restore Live Activity device preference.", cause),
        ),
      );
    });

    yield* updateEnvironmentPreference(input.enabled).pipe(
      Effect.onError(() => restoreEnvironmentPreference()),
    );
  },
);
