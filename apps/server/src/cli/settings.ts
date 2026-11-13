import {
  type AuthEnvironmentScope,
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  EnvironmentHttpApi,
  requiredScopesForServerSettingsPatch,
  type ServerSettingsApplyInput,
  type ServerSettingsError,
  ServerSettingsPatch,
  type ServerSettingsSnapshot,
  type ServerSettingsUpdateResult,
  StoredSettingsDocument,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schedule from "effect/Schedule";
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
  applyStoredSettings,
  patchStoredSettings,
  readSettingsSnapshot,
  settingsErrorMessage,
} from "../settingsAccess.ts";
import {
  authLocationFlags,
  type CliAuthLocationFlags,
  DurationFromString,
  resolveCliAuthConfig,
} from "./config.ts";

/** Exit code for failures that may pass: a server starting, busy, or older than this CLI. */
const SETTINGS_EXIT_TEMPORARY = 75;

class SettingsInputError extends Schema.TaggedError<SettingsInputError>()("SettingsInputError", {
  source: Schema.String,
  detail: Schema.String,
}) {
  override get message(): string {
    return `Invalid input from ${this.source}. Nothing was changed.\n${this.detail}`;
  }
}

class SettingsFailedError extends Schema.TaggedError<SettingsFailedError>()("SettingsFailedError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

class SettingsBusyError extends Schema.TaggedError<SettingsBusyError>()("SettingsBusyError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

type SettingsCommandError = SettingsFailedError | SettingsBusyError;

interface SettingsSession {
  readonly mode: "live" | "offline";
  readonly location: string;
  readonly snapshot: ServerSettingsSnapshot;
  readonly patch: (
    patch: ServerSettingsPatch,
  ) => Effect.Effect<ServerSettingsUpdateResult, SettingsCommandError>;
  readonly apply: (
    input: ServerSettingsApplyInput,
  ) => Effect.Effect<ServerSettingsUpdateResult, SettingsCommandError>;
}

const LIVE_REQUEST_TIMEOUT = Duration.seconds(10);
const SESSION_TTL = Duration.minutes(2);
const WAIT_INTERVAL = Duration.seconds(2);

const failureDetail = (cause: unknown) =>
  cause instanceof Error && cause.message.length > 0 ? cause.message : String(cause);

const hasTag = (cause: unknown, tag: string) =>
  typeof cause === "object" && cause !== null && "_tag" in cause && cause._tag === tag;

// A server that never answered means offline; any answer means one is running.
const isUnreachable = (cause: unknown) =>
  HttpClientError.isHttpClientError(cause) && cause.response === undefined;

const TEMPORARY_STATUSES: ReadonlySet<number> = new Set([404, 502, 503, 504]);

const liveFailure = (origin: string, cause: unknown): SettingsCommandError => {
  if (hasTag(cause, "EnvironmentHttpBadRequestError")) {
    return new SettingsFailedError({ detail: failureDetail(cause), cause });
  }
  if (isUnreachable(cause) || hasTag(cause, "TimeoutError")) {
    return new SettingsBusyError({
      detail: `The T3 Code server at ${origin} did not answer in time.`,
      cause,
    });
  }
  if (HttpClientError.isHttpClientError(cause) && cause.response !== undefined) {
    const { status } = cause.response;
    return TEMPORARY_STATUSES.has(status)
      ? new SettingsBusyError({
          detail: `The T3 Code server at ${origin} answered HTTP ${status}; it may be starting or older than this CLI.`,
          cause,
        })
      : new SettingsFailedError({
          detail: `The T3 Code server at ${origin} answered HTTP ${status}.`,
          cause,
        });
  }
  if (hasTag(cause, "SchemaError")) {
    return new SettingsBusyError({
      detail: `The T3 Code server at ${origin} sent an answer this CLI cannot read; it may be older than this CLI.`,
      cause,
    });
  }
  return new SettingsFailedError({
    detail: `The T3 Code server at ${origin} failed: ${failureDetail(cause)}`,
    cause,
  });
};

const commandFailure = (cause: unknown): SettingsCommandError =>
  hasTag(cause, "SettingsBusyError") || hasTag(cause, "SettingsFailedError")
    ? (cause as SettingsCommandError)
    : new SettingsFailedError({
        detail: hasTag(cause, "ServerSettingsError")
          ? settingsErrorMessage(cause as ServerSettingsError)
          : failureDetail(cause),
        cause,
      });

const withLiveSession = <A, E, R>(
  environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"],
  scopes: ReadonlyArray<AuthEnvironmentScope>,
  run: (token: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    environmentAuth.issueSession({
      scopes: [...scopes],
      label: "t3 settings cli",
      ttl: SESSION_TTL,
    }),
    (issued) => run(issued.token),
    (issued) => environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
  );

const offlineLayer = ServerSettingsService.layer.pipe(
  Layer.provide(Layer.merge(ServerSecretStore.layer, ManagedPolicy.layer)),
  // Migrating is safe here: the command holds the server ownership lock.
  Layer.provide(SqlitePersistence.layerConfig),
);

const runWithSettings = Effect.fn("cli.settings.run")(function* <A>(
  flags: CliAuthLocationFlags & { readonly liveOnly: boolean },
  scopes: ReadonlyArray<AuthEnvironmentScope>,
  use: (session: SettingsSession) => Effect.Effect<A, SettingsCommandError>,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel, { quietLogs: true });
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
          const request = <B, E>(effect: Effect.Effect<B, E>) =>
            effect.pipe(
              Effect.timeout(LIVE_REQUEST_TIMEOUT),
              Effect.mapError((cause) => liveFailure(origin, cause)),
            );
          const snapshot = yield* client.server.settings({ headers }).pipe(
            Effect.timeout(LIVE_REQUEST_TIMEOUT),
            Effect.asSome,
            Effect.catch((cause) =>
              isUnreachable(cause)
                ? Effect.succeed(Option.none<ServerSettingsSnapshot>())
                : Effect.fail(liveFailure(origin, cause)),
            ),
          );
          if (Option.isNone(snapshot)) return Option.none<A>();
          return Option.some(
            yield* use({
              mode: "live",
              location: origin,
              snapshot: snapshot.value,
              patch: (patch) =>
                request(client.server.patchSettings({ headers, payload: { patch } })),
              apply: (payload) => request(client.server.applySettings({ headers, payload })),
            }),
          );
        }),
      );
      if (Option.isSome(live)) return live.value;
    }

    if (flags.liveOnly) {
      return yield* new SettingsBusyError({ detail: "No running T3 Code server answered." });
    }
    // An unreachable server may still be running or starting; the lock refuses to write behind it.
    yield* ServerOwnership.acquireServerOwnership(config.serverRuntimeStatePath).pipe(
      Effect.provide(ProcessRunner.layer),
      Effect.catchTags({
        ServerAlreadyRunningError: (cause) =>
          Effect.fail(
            new SettingsBusyError({
              detail: `A T3 Code server owns ${config.stateDir} but did not answer; it may be starting.`,
              cause,
            }),
          ),
      }),
    );
    yield* clearPersistedServerRuntimeState(config.serverRuntimeStatePath);
    return yield* Effect.gen(function* () {
      type OfflineServices =
        | Effect.Services<ReturnType<typeof readSettingsSnapshot>>
        | Effect.Services<ReturnType<typeof patchStoredSettings>>
        | Effect.Services<ReturnType<typeof applyStoredSettings>>;
      const context = yield* Effect.context<OfflineServices>();
      const offline = <B, E>(effect: Effect.Effect<B, E, OfflineServices>) =>
        effect.pipe(Effect.provide(context), Effect.mapError(commandFailure));
      return yield* use({
        mode: "offline",
        location: config.settingsPath,
        snapshot: yield* offline(readSettingsSnapshot()),
        patch: (patch) => offline(patchStoredSettings(patch)),
        apply: (input) => offline(applyStoredSettings(input)),
      });
    }).pipe(Effect.provide(offlineLayer));
  }).pipe(
    Effect.scoped,
    Effect.mapError(commandFailure),
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

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
  );
}

const formatValue = (value: unknown) =>
  value === undefined ? "(default)" : JSON.stringify(sortKeys(value));

function formatSettings(
  session: Pick<SettingsSession, "mode">,
  settings: unknown,
  options: { readonly json: boolean },
): string {
  return options.json
    ? JSON.stringify(sortKeys({ mode: session.mode, settings }))
    : JSON.stringify(sortKeys(settings), null, 2);
}

function formatResult(
  session: Pick<SettingsSession, "mode" | "location">,
  result: ServerSettingsUpdateResult,
  options: { readonly json: boolean; readonly dryRun: boolean },
): string {
  if (options.json) {
    return JSON.stringify(sortKeys({ mode: session.mode, dryRun: options.dryRun, ...result }));
  }
  const location =
    session.mode === "live"
      ? `through the running server at ${session.location}`
      : `in ${session.location} (no server running)`;
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  const { changes, secrets } = result;
  if (changes.length + secrets.length === 0) {
    return `No settings ${options.dryRun ? "would change" : "changed"} ${location}.`;
  }
  const counts = [
    ...(changes.length > 0 ? [count(changes.length, "setting")] : []),
    ...(secrets.length > 0 ? [count(secrets.length, "secret")] : []),
  ].join(" and ");
  return [
    `${options.dryRun ? "Would change" : "Changed"} ${counts} ${location}:`,
    ...changes.map(
      (change) =>
        `  ${change.path.join(".")}: ${formatValue(change.before)} -> ${formatValue(change.after)}`,
    ),
    ...secrets.map((secret) => `  ${secret.secret}: secret ${secret.change}`),
  ].join("\n");
}

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit one JSON object instead of human-readable output."),
  Flag.withDefault(false),
);

const waitFlag = Flag.String("wait").pipe(
  Flag.withSchema(DurationFromString),
  Flag.withDescription(
    "Keep retrying while T3 Code is starting or busy, for up to this long, for example `2m`.",
  ),
  Flag.optional,
);

const readText = Effect.fnUntraced(function* (source: string) {
  if (source !== "-") return yield* (yield* FileSystem.FileSystem).readFileString(source);
  const stdio = yield* Stdio.Stdio;
  return yield* stdio.stdin.pipe(Stream.decodeText(), Stream.mkString);
});

// A misspelled key would otherwise be dropped silently and change nothing.
const readInput = <A>(source: string, schema: Schema.Codec<A, string, never, never>) =>
  readText(source).pipe(
    Effect.flatMap((text) =>
      Schema.decodeEffect(schema)(text, { onExcessProperty: "error", errors: "all" }),
    ),
    Effect.mapError(
      (cause) =>
        new SettingsInputError({
          source: source === "-" ? "stdin" : source,
          detail: failureDetail(cause),
        }),
    ),
  );

const decodePatchJson = Schema.fromJsonString(ServerSettingsPatch);
const decodeDocumentJson = Schema.fromJsonString(StoredSettingsDocument);

const retryWhileBusy = <A, E, R>(
  wait: Option.Option<Duration.Duration>,
  effect: Effect.Effect<A, E, R>,
) =>
  Option.isNone(wait)
    ? effect
    : effect.pipe(
        Effect.retry({
          while: (error) => hasTag(error, "SettingsBusyError"),
          schedule: Schedule.spaced(WAIT_INTERVAL).pipe(Schedule.upTo({ duration: wait.value })),
        }),
      );

// Stdout carries only results; temporary failures exit 75 so callers can tell them from bad input.
const reportFailure = <A, E, R>(
  wait: Option.Option<Duration.Duration>,
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.catch((error) => {
      const busy = hasTag(error, "SettingsBusyError");
      const hint = !busy
        ? ""
        : Option.isSome(wait)
          ? ` Gave up after waiting ${Duration.format(wait.value)}.`
          : " Try again, or pass --wait <duration>.";
      return Console.error(`${failureDetail(error)}${hint}`).pipe(
        Effect.andThen(
          Effect.sync(() => {
            process.exitCode = busy ? SETTINGS_EXIT_TEMPORARY : 1;
          }),
        ),
      );
    }),
    Effect.provideService(References.LogToStderr, true),
  );

const liveOnlyFlag = Flag.Boolean("live-only").pipe(
  Flag.withDescription(
    "Exit 75 instead of opening the T3 home directly when no running server answers.",
  ),
  Flag.withDefault(false),
);

const settingsGetCommand = Command.make("get", {
  ...authLocationFlags,
  json: jsonFlag,
  sparse: Flag.Boolean("sparse").pipe(
    Flag.withDescription(
      "Print the stored document instead: patchable values that differ from the defaults.",
    ),
    Flag.withDefault(false),
  ),
  wait: waitFlag,
  liveOnly: liveOnlyFlag,
}).pipe(
  Command.withDescription(
    "Print the effective server settings, defaults included, with secrets redacted.",
  ),
  Command.withHandler((flags) =>
    reportFailure(
      flags.wait,
      retryWhileBusy(
        flags.wait,
        runWithSettings(flags, [AuthOrchestrationReadScope], (session) =>
          Console.log(
            formatSettings(
              session,
              flags.sparse ? session.snapshot.stored : session.snapshot.settings,
              { json: flags.json },
            ),
          ),
        ),
      ),
    ),
  ),
);

const settingsPatchCommand = Command.make("patch", {
  ...authLocationFlags,
  json: jsonFlag,
  wait: waitFlag,
  liveOnly: liveOnlyFlag,
  source: Argument.String("file").pipe(
    Argument.withDescription("JSON file holding a settings patch, or - to read it from stdin."),
  ),
}).pipe(
  Command.withDescription(
    "Apply a settings patch the way the settings UI does, then print what changed.",
  ),
  Command.withHandler((flags) =>
    reportFailure(
      flags.wait,
      Effect.gen(function* () {
        // Read once: a retry must not read a consumed stdin again.
        const patch = yield* readInput(flags.source, decodePatchJson);
        const scopes = [AuthOrchestrationReadScope, ...requiredScopesForServerSettingsPatch(patch)];
        yield* retryWhileBusy(
          flags.wait,
          runWithSettings(flags, scopes, (session) =>
            session
              .patch(patch)
              .pipe(
                Effect.flatMap((result) =>
                  Console.log(formatResult(session, result, { json: flags.json, dryRun: false })),
                ),
              ),
          ),
        );
      }),
    ),
  ),
);

const settingsApplyCommand = Command.make("apply", {
  ...authLocationFlags,
  json: jsonFlag,
  wait: waitFlag,
  liveOnly: liveOnlyFlag,
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("Print the changes without writing anything."),
    Flag.withDefault(false),
  ),
  base: Flag.String("base").pipe(
    Flag.withDescription(
      "The previously applied document. Only paths where the desired document differs from it change.",
    ),
    Flag.optional,
  ),
  source: Argument.String("desired").pipe(
    Argument.withDescription(
      "JSON file holding the desired settings document (the form `get --sparse` prints), or -.",
    ),
  ),
}).pipe(
  Command.withDescription("Make the stored settings match a document, then print what changed."),
  Command.withHandler((flags) =>
    reportFailure(
      flags.wait,
      Effect.gen(function* () {
        // Read once: a retry must not read a consumed stdin again.
        const desired = yield* readInput(flags.source, decodeDocumentJson);
        const base = Option.isSome(flags.base)
          ? yield* readInput(flags.base.value, decodeDocumentJson)
          : undefined;
        const scopes = [
          AuthOrchestrationReadScope,
          AuthSettingsWriteScope,
          AuthProvidersManageScope,
        ];
        yield* retryWhileBusy(
          flags.wait,
          runWithSettings(flags, scopes, (session) =>
            session
              .apply({ desired, ...(base === undefined ? {} : { base }), dryRun: flags.dryRun })
              .pipe(
                Effect.flatMap((result) =>
                  Console.log(
                    formatResult(session, result, { json: flags.json, dryRun: flags.dryRun }),
                  ),
                ),
              ),
          ),
        );
      }),
    ),
  ),
);

export const settingsCommand = Command.make("settings").pipe(
  Command.withDescription("Read or change the server settings."),
  Command.withSubcommands([settingsGetCommand, settingsPatchCommand, settingsApplyCommand]),
);
