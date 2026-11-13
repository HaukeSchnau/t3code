import {
  type AuthEnvironmentScope,
  AuthOrchestrationReadScope,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentHttpApi,
  requiredScopesForServerSettingsPatch,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";
import { FetchHttpClient, HttpClientError } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerOwnership from "../serverOwnership.ts";
import {
  clearPersistedServerRuntimeState,
  readPersistedServerRuntimeState,
} from "../serverRuntimeState.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import {
  readSettingsForClient,
  settingsErrorMessage,
  updateSettingsForClient,
} from "../settingsAccess.ts";
import { authLocationFlags, type CliAuthLocationFlags, resolveCliAuthConfig } from "./config.ts";

export class SettingsPatchInputError extends Schema.TaggedError<SettingsPatchInputError>()(
  "SettingsPatchInputError",
  { source: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `Invalid settings patch from ${this.source}. Nothing was changed.\n${this.detail}`;
  }
}

export class SettingsRejectedError extends Schema.TaggedError<SettingsRejectedError>()(
  "SettingsRejectedError",
  { detail: Schema.String },
) {
  override get message(): string {
    return `T3 Code rejected the settings patch. Nothing was changed.\n${this.detail}`;
  }
}

export class SettingsServerError extends Schema.TaggedError<SettingsServerError>()(
  "SettingsServerError",
  { origin: Schema.String, detail: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `The running T3 Code server at ${this.origin} could not answer: ${this.detail}`;
  }
}

export class SettingsOfflineError extends Schema.TaggedError<SettingsOfflineError>()(
  "SettingsOfflineError",
  { settingsPath: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `Could not read the settings in ${this.settingsPath}.\n${this.detail}`;
  }
}

type SettingsMode = "live" | "offline";

interface SettingsSession {
  readonly mode: SettingsMode;
  readonly location: string;
  readonly current: ServerSettings;
  readonly update: (
    patch: ServerSettingsPatch,
  ) => Effect.Effect<ServerSettings, SettingsRejectedError | SettingsServerError>;
}

const LIVE_REQUEST_TIMEOUT = Duration.seconds(10);

const encodeSettings = Schema.encodeUnknownEffect(ServerSettings);
const decodePatchJson = Schema.decodeUnknownEffect(Schema.fromJsonString(ServerSettingsPatch));

const failureDetail = (cause: unknown) =>
  cause instanceof Error && cause.message.length > 0 ? cause.message : String(cause);

// A server that never answered falls back to offline; one that answered badly is an error.
const isUnreachable = (cause: unknown) =>
  (HttpClientError.isHttpClientError(cause) && cause.response === undefined) ||
  (typeof cause === "object" && cause !== null && "_tag" in cause && cause._tag === "TimeoutError");

const withLiveSession = <A, E, R>(
  environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"],
  scopes: ReadonlyArray<AuthEnvironmentScope>,
  run: (token: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    environmentAuth.issueSession({ scopes: [...scopes], label: "t3 settings cli" }),
    (issued) => run(issued.token),
    (issued) => environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
  );

const offlineLayer = ServerSettingsService.layer.pipe(
  Layer.provide(Layer.merge(ServerSecretStore.layer, ManagedPolicy.layer)),
  // Migrating is safe here: the command holds the server ownership lock.
  Layer.provide(SqlitePersistence.layerConfig),
);

const runWithSettings = Effect.fn("cli.settings.run")(function* <A, E, R>(
  flags: CliAuthLocationFlags,
  scopes: ReadonlyArray<AuthEnvironmentScope>,
  use: (session: SettingsSession) => Effect.Effect<A, E, R>,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel, { quietLogs: true });
  // Logs share stdout with the settings output, so they stay quiet unless asked for.
  const minimumLogLevel = Option.isSome(logLevel) ? config.logLevel : "Error";

  return yield* Effect.gen(function* () {
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isSome(runtimeState)) {
      const origin = runtimeState.value.origin;
      const live = yield* withLiveSession(environmentAuth, scopes, (token) =>
        Effect.gen(function* () {
          const client = yield* HttpApiClient.make(EnvironmentHttpApi, { baseUrl: origin });
          const headers = { authorization: `Bearer ${token}` };
          const serverError = (cause: unknown) =>
            new SettingsServerError({ origin, detail: failureDetail(cause), cause });
          const current = yield* client.server.settings({ headers }).pipe(
            Effect.timeout(LIVE_REQUEST_TIMEOUT),
            Effect.asSome,
            Effect.catch((cause) =>
              isUnreachable(cause)
                ? Effect.logDebug("No running server answered; using offline mode.", {
                    origin,
                    cause,
                  }).pipe(Effect.as(Option.none<ServerSettings>()))
                : Effect.fail(serverError(cause)),
            ),
          );
          if (Option.isNone(current)) return Option.none<A>();
          return Option.some(
            yield* use({
              mode: "live",
              location: origin,
              current: current.value,
              update: (patch) =>
                client.server.updateSettings({ headers, payload: { patch } }).pipe(
                  Effect.timeout(LIVE_REQUEST_TIMEOUT),
                  Effect.mapError((cause) =>
                    cause._tag === "EnvironmentHttpBadRequestError"
                      ? new SettingsRejectedError({ detail: cause.message })
                      : serverError(cause),
                  ),
                ),
            }),
          );
        }),
      );
      if (Option.isSome(live)) return live.value;
    }

    // An unreachable server may still be running; the lock fails rather than write behind it.
    yield* ServerOwnership.acquireServerOwnership(config.serverRuntimeStatePath).pipe(
      Effect.provide(ProcessRunner.layer),
    );
    yield* clearPersistedServerRuntimeState(config.serverRuntimeStatePath);
    return yield* Effect.gen(function* () {
      const updateContext =
        yield* Effect.context<Effect.Services<ReturnType<typeof updateSettingsForClient>>>();
      const current = yield* readSettingsForClient().pipe(
        Effect.mapError(
          (error) =>
            new SettingsOfflineError({
              settingsPath: config.settingsPath,
              detail: settingsErrorMessage(error),
            }),
        ),
      );
      return yield* use({
        mode: "offline",
        location: config.settingsPath,
        current,
        update: (patch) =>
          updateSettingsForClient(patch).pipe(
            Effect.provide(updateContext),
            Effect.mapError(
              (error) => new SettingsRejectedError({ detail: settingsErrorMessage(error) }),
            ),
          ),
      });
    }).pipe(Effect.provide(offlineLayer));
  }).pipe(
    Effect.scoped,
    Effect.provide(
      EnvironmentAuth.layerRuntime.pipe(
        Layer.provideMerge(FetchHttpClient.layer),
        Layer.provideMerge(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
      ),
    ),
    Effect.provideService(References.MinimumLogLevel, minimumLogLevel),
  );
});

interface SettingsChange {
  readonly path: ReadonlyArray<string>;
  readonly before?: unknown;
  readonly after?: unknown;
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Leaf-level differences between two encoded settings documents; arrays compare whole. */
function settingsChanges(
  before: unknown,
  after: unknown,
  path: ReadonlyArray<string> = [],
): ReadonlyArray<SettingsChange> {
  if (isPlainRecord(before) && isPlainRecord(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].flatMap((key) => settingsChanges(before[key], after[key], [...path, key]));
  }
  if (Equal.equals(before, after)) return [];
  return [
    {
      path,
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
    },
  ];
}

const formatValue = (value: unknown) => (value === undefined ? "(unset)" : JSON.stringify(value));

function formatSettings(
  session: Pick<SettingsSession, "mode">,
  settings: unknown,
  options: { readonly json: boolean },
): string {
  return options.json
    ? JSON.stringify({ mode: session.mode, settings })
    : JSON.stringify(settings, null, 2);
}

function formatChanges(
  session: Pick<SettingsSession, "mode" | "location">,
  changes: ReadonlyArray<SettingsChange>,
  options: { readonly json: boolean },
): string {
  if (options.json) return JSON.stringify({ mode: session.mode, changes });
  const location =
    session.mode === "live"
      ? `through the running server at ${session.location}`
      : `in ${session.location} (no server running)`;
  if (changes.length === 0) return `No settings changed ${location}.`;
  return [
    `Changed ${changes.length} setting${changes.length === 1 ? "" : "s"} ${location}:`,
    ...changes.map(
      (change) =>
        `  ${change.path.join(".")}: ${formatValue(change.before)} -> ${formatValue(change.after)}`,
    ),
  ].join("\n");
}

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit one JSON object instead of human-readable output."),
  Flag.withDefault(false),
);

const sparseFlag = Flag.Boolean("sparse").pipe(
  Flag.withDescription("Print only values that differ from T3 Code's defaults."),
  Flag.withDefault(false),
);

const readPatchText = Effect.fn("cli.settings.readPatchText")(function* (source: string) {
  if (source === "-") {
    return yield* Stdio.Stdio.pipe(
      Effect.flatMap((stdio) => stdio.stdin.pipe(Stream.decodeText(), Stream.mkString)),
    );
  }
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(source);
});

const readSettingsPatch = Effect.fn("cli.settings.readPatch")(function* (source: string) {
  const label = source === "-" ? "stdin" : source;
  const text = yield* readPatchText(source).pipe(
    Effect.mapError(
      (cause) => new SettingsPatchInputError({ source: label, detail: failureDetail(cause) }),
    ),
  );
  // A misspelled key would otherwise be dropped silently and change nothing.
  return yield* decodePatchJson(text, { onExcessProperty: "error", errors: "all" }).pipe(
    Effect.mapError(
      (cause) => new SettingsPatchInputError({ source: label, detail: failureDetail(cause) }),
    ),
  );
});

// Stdout carries only settings output, so scripts never parse a failure as data.
const reportFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catch((error) =>
      Console.error(failureDetail(error)).pipe(
        Effect.andThen(
          Effect.sync(() => {
            process.exitCode = 1;
          }),
        ),
      ),
    ),
  );

const settingsGetCommand = Command.make("get", {
  ...authLocationFlags,
  json: jsonFlag,
  sparse: sparseFlag,
}).pipe(
  Command.withDescription(
    "Print the effective server settings, defaults included, with secrets redacted.",
  ),
  Command.withHandler((flags) =>
    runWithSettings(flags, [AuthOrchestrationReadScope], (session) =>
      Effect.gen(function* () {
        const shown = flags.sparse
          ? (ServerSettingsService.stripDefaultServerSettings(
              session.current,
              DEFAULT_SERVER_SETTINGS,
            ) ?? {})
          : session.current;
        yield* Console.log(
          formatSettings(session, yield* encodeSettings(shown), { json: flags.json }),
        );
      }),
    ).pipe(reportFailure),
  ),
);

const settingsPatchCommand = Command.make("patch", {
  ...authLocationFlags,
  json: jsonFlag,
  source: Argument.String("file").pipe(
    Argument.withDescription("JSON file holding a settings patch, or - to read it from stdin."),
  ),
}).pipe(
  Command.withDescription(
    "Apply a settings patch the way the settings UI does, then print what changed.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const patch = yield* readSettingsPatch(flags.source);
      const scopes = [AuthOrchestrationReadScope, ...requiredScopesForServerSettingsPatch(patch)];
      yield* runWithSettings(flags, scopes, (session) =>
        Effect.gen(function* () {
          const before = yield* encodeSettings(session.current);
          const after = yield* encodeSettings(yield* session.update(patch));
          yield* Console.log(
            formatChanges(session, settingsChanges(before, after), { json: flags.json }),
          );
        }),
      );
    }).pipe(reportFailure),
  ),
);

export const settingsCommand = Command.make("settings").pipe(
  Command.withDescription("Read or change the server settings."),
  Command.withSubcommands([settingsGetCommand, settingsPatchCommand]),
);
