import {
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
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
  applyStoredSettings,
  patchStoredSettings,
  readSettingsSnapshot,
} from "../settingsAccess.ts";
import { getServerIdleStatus } from "./IdleStatus.ts";

// Clients get the error's own message; its cause can hold payload fragments or provider
// diagnostics, so only the server log sees it.
const rejected = (error: Error) =>
  Effect.logWarning("settings request rejected", { cause: error }).pipe(
    Effect.andThen(Effect.fail(new EnvironmentHttpBadRequestError({ message: error.message }))),
  );

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
          return yield* readSettingsSnapshot().pipe(
            Effect.catchTags({
              ServerSettingsError: rejected,
            }),
          );
        }),
      )
      .handle(
        "patchSettings",
        Effect.fn("environment.server.patchSettings")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          for (const scope of requiredScopesForServerSettingsPatch(args.payload.patch)) {
            yield* requireEnvironmentScope(scope);
          }
          return yield* patchStoredSettings(args.payload.patch).pipe(
            Effect.catchTags({
              ServerSettingsError: rejected,
            }),
          );
        }),
      )
      .handle(
        "applySettings",
        Effect.fn("environment.server.applySettings")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthSettingsWriteScope);
          yield* requireEnvironmentScope(AuthProvidersManageScope);
          return yield* applyStoredSettings(args.payload).pipe(
            Effect.catchTags({
              ServerSettingsError: rejected,
              SettingsDocumentError: rejected,
            }),
          );
        }),
      );
  }),
);
