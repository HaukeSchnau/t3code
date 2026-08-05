import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthTokenExchangeGrantType,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import { encodeOAuthScope } from "@t3tools/shared/oauthScope";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  RemoteEnvironmentRegistry,
  layer as RemoteEnvironmentRegistryLive,
} from "../mcp/toolkits/thread-orchestration/RemoteEnvironmentRegistry.ts";
import { authLocationFlags, type CliAuthLocationFlags, resolveCliAuthConfig } from "./config.ts";

const orchestrationScopes = [AuthOrchestrationReadScope, AuthOrchestrationOperateScope] as const;
const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

class RemoteRegisterInputError extends Schema.TaggedErrorClass<RemoteRegisterInputError>()(
  "RemoteRegisterInputError",
  {
    message: Schema.String,
  },
) {}

const baseUrlFlag = Flag.string("base-url").pipe(
  Flag.withDescription("Remote T3 Code HTTP base URL, for example https://t3.schnau.dev."),
);
const wsBaseUrlFlag = Flag.string("ws-base-url").pipe(
  Flag.withDescription("Optional remote T3 Code WebSocket base URL."),
  Flag.optional,
);
const pairingTokenFlag = Flag.string("pairing-token").pipe(
  Flag.withDescription(
    "One-time remote pairing token to exchange for an orchestration bearer session.",
  ),
  Flag.optional,
);
const bearerTokenFlag = Flag.string("bearer-token").pipe(
  Flag.withDescription(
    "Already-issued remote bearer token with orchestration read/operate scopes.",
  ),
  Flag.optional,
);
const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const normalizeBaseUrl = (value: string): string => {
  const url = new URL(value);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
};

const withRemoteRegistry = <A, E, R>(
  flags: CliAuthLocationFlags,
  run: (registry: RemoteEnvironmentRegistry["Service"]) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCliAuthConfig(flags, logLevel);
    return yield* Effect.gen(function* () {
      const registry = yield* RemoteEnvironmentRegistry;
      return yield* run(registry);
    }).pipe(
      Effect.provide(
        RemoteEnvironmentRegistryLive.pipe(
          Layer.provide(ServerSecretStore.layer),
          Layer.provide(ServerConfig.layer(config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
        ),
      ),
    );
  });

const makeClient = (baseUrl: string) =>
  HttpApiClient.make(EnvironmentHttpApi, {
    baseUrl,
  });

const fetchDescriptor = (baseUrl: string) =>
  Effect.gen(function* () {
    const client = yield* makeClient(baseUrl);
    return yield* client.metadata.descriptor();
  }).pipe(Effect.provide(FetchHttpClient.layer));

const exchangePairingToken = (baseUrl: string, pairingToken: string) =>
  Effect.gen(function* () {
    const client = yield* makeClient(baseUrl);
    const token = yield* client.auth.token({
      headers: {},
      payload: {
        grant_type: AuthTokenExchangeGrantType,
        subject_token: pairingToken,
        subject_token_type: AuthEnvironmentBootstrapTokenType,
        requested_token_type: AuthAccessTokenType,
        scope: encodeOAuthScope(orchestrationScopes),
        client_label: "T3 Code remote orchestration",
        client_device_type: "bot",
      },
    });
    return token.access_token;
  }).pipe(Effect.provide(FetchHttpClient.layer));

const remoteRegisterCommand = Command.make("register", {
  ...authLocationFlags,
  baseUrl: baseUrlFlag,
  wsBaseUrl: wsBaseUrlFlag,
  pairingToken: pairingTokenFlag,
  bearerToken: bearerTokenFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Register a remote T3 Code environment for agent thread orchestration."),
  Command.withHandler((flags) =>
    withRemoteRegistry(
      flags,
      Effect.fn("remoteRegisterCommand")(function* (registry) {
        const pairingToken = Option.getOrUndefined(flags.pairingToken);
        const bearerToken = Option.getOrUndefined(flags.bearerToken);
        if ((pairingToken === undefined) === (bearerToken === undefined)) {
          return yield* new RemoteRegisterInputError({
            message: "Pass exactly one of --pairing-token or --bearer-token.",
          });
        }

        const baseUrl = normalizeBaseUrl(flags.baseUrl);
        const descriptor = yield* fetchDescriptor(baseUrl);
        const token = bearerToken ?? (yield* exchangePairingToken(baseUrl, pairingToken!));
        const registered = yield* registry.register({
          descriptor,
          httpBaseUrl: baseUrl,
          ...(Option.isSome(flags.wsBaseUrl) ? { wsBaseUrl: flags.wsBaseUrl.value } : {}),
          bearerToken: token,
        });
        yield* Console.log(
          flags.json
            ? yield* encodeJsonString(registered)
            : `Registered remote environment ${registered.environmentId} (${registered.label}) at ${registered.httpBaseUrl}.`,
        );
      }),
    ),
  ),
);

const remoteListCommand = Command.make("list", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List remote T3 Code environments registered for orchestration."),
  Command.withHandler((flags) =>
    withRemoteRegistry(
      flags,
      Effect.fn("remoteListCommand")(function* (registry) {
        const environments = yield* registry.list();
        yield* Console.log(
          flags.json
            ? yield* encodeJsonString({ environments })
            : environments
                .map(
                  (environment) =>
                    `${environment.environmentId}\t${environment.label}\t${environment.httpBaseUrl}`,
                )
                .join("\n"),
        );
      }),
    ),
  ),
);

export const remoteCommand = Command.make("remote").pipe(
  Command.withDescription("Manage remote T3 Code environments for agent orchestration."),
  Command.withSubcommands([remoteRegisterCommand, remoteListCommand]),
);
