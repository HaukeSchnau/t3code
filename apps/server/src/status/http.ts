import {
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  EnvironmentHttpBadRequestError,
  requiredScopesForServerSettingsPatch,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../auth/http.ts";
import {
  readSettingsForClient,
  settingsErrorMessage,
  updateSettingsForClient,
} from "../settingsAccess.ts";
import { getServerIdleStatus } from "./IdleStatus.ts";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "server",
  Effect.fnUntraced(function* (handlers) {
    return handlers
      .handle(
        "idleStatus",
        Effect.fn("environment.server.idleStatus")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* getServerIdleStatus().pipe(
            Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)),
          );
        }),
      )
      .handle(
        "settings",
        Effect.fn("environment.server.settings")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* readSettingsForClient().pipe(
            Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)),
          );
        }),
      )
      .handle(
        "updateSettings",
        Effect.fn("environment.server.updateSettings")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          for (const scope of requiredScopesForServerSettingsPatch(args.payload.patch)) {
            yield* requireEnvironmentScope(scope);
          }
          return yield* updateSettingsForClient(args.payload.patch).pipe(
            Effect.catchTags({
              ServerSettingsError: (error) =>
                Effect.fail(
                  new EnvironmentHttpBadRequestError({ message: settingsErrorMessage(error) }),
                ),
            }),
          );
        }),
      );
  }),
);
