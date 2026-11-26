import {
  AuthEnvironmentMaintainScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  type ServerIdleBusyReason,
  type ServerIdleBusyThread,
  type ServerIdleStatus,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/cli";
import { FetchHttpClient, HttpClientError } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { getServerIdleStatus } from "../status/IdleStatus.ts";
import { authLocationFlags, type CliAuthLocationFlags, resolveCliAuthConfig } from "./config.ts";

class StatusLiveServerUnavailableError extends Schema.TaggedError<StatusLiveServerUnavailableError>()(
  "StatusLiveServerUnavailableError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

class StatusOfflineUnavailableError extends Schema.TaggedError<StatusOfflineUnavailableError>()(
  "StatusOfflineUnavailableError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const quietFlag = Flag.Boolean("quiet").pipe(
  Flag.withDescription("Suppress output and use the exit code only."),
  Flag.withDefault(false),
);

const drainFlag = Flag.Boolean("drain").pipe(
  Flag.withDescription(
    "First tell the running server that a release waits for it, so it takes no placed threads.",
  ),
  Flag.withDefault(false),
);

const makeLiveServerClient = (origin: string) =>
  HttpApiClient.make(EnvironmentHttpApi, {
    baseUrl: origin,
  });

const withStatusCliSessionToken = <A, E, R>(
  environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"],
  drain: boolean,
  run: (token: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    environmentAuth.issueSession({
      scopes: drain
        ? [AuthOrchestrationReadScope, AuthEnvironmentMaintainScope]
        : [AuthOrchestrationReadScope],
      label: "t3 status cli",
    }),
    (issued) => run(issued.token),
    (issued) => environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
  );

const BUSY_REASON_TEXT: Record<ServerIdleBusyReason, string> = {
  "pending-user-input": "waits for an answer to its question",
  "pending-approval": "waits for an approval",
  "live-provider-active-turn": "is running a turn",
  "projected-active-turn": "is running a turn",
  "projected-latest-turn-running": "is running a turn",
  "live-provider-session-busy": "has a busy agent session",
  "projected-session-starting": "is starting its agent",
  "queued-message": "has a queued message",
  "undelivered-transcript-events": "has undelivered events",
  "command-in-progress": "has a command in progress",
};
// What only the user can end comes first: a deploy prints this as the reason it waits.
const waitsOnUser = (reason: ServerIdleBusyReason) =>
  reason === "pending-user-input" || reason === "pending-approval" ? 0 : 1;

export function formatIdleStatus(
  status: ServerIdleStatus,
  options: { readonly json: boolean },
): string {
  if (options.json) {
    return JSON.stringify(status);
  }
  if (status.idle) {
    return "T3 Code is idle.";
  }
  const byThread = new Map<string, ServerIdleBusyThread>();
  for (const thread of status.busyThreads) {
    const known = byThread.get(thread.threadId);
    if (known === undefined || waitsOnUser(thread.reason) < waitsOnUser(known.reason)) {
      byThread.set(thread.threadId, thread);
    }
  }
  const threads = [...byThread.values()].toSorted(
    (left, right) => waitsOnUser(left.reason) - waitsOnUser(right.reason),
  );
  if (threads.length === 0) return "T3 Code is busy.";
  return [
    `T3 Code is busy with ${threads.length} ${threads.length === 1 ? "thread" : "threads"}:`,
    ...threads.map((thread) => {
      const title = thread.title === undefined ? "" : `"${thread.title.replace(/\s+/g, " ")}" `;
      return `${title}(${thread.threadId}) ${BUSY_REASON_TEXT[thread.reason]}`;
    }),
  ].join("\n");
}

function formatUnknownStatus(input: { readonly reason: string; readonly json: boolean }): string {
  if (input.json) {
    return JSON.stringify({
      idle: false,
      unknown: true,
      reason: input.reason,
    });
  }
  return `T3 Code idle status is unknown: ${input.reason}`;
}

const setExitCode = (code: number) =>
  Effect.sync(() => {
    process.exitCode = code;
  });

function failureMessage(failure: unknown): string {
  if (
    typeof failure === "object" &&
    failure !== null &&
    "message" in failure &&
    typeof failure.message === "string"
  ) {
    return failure.message;
  }
  return "probe failed";
}

const queryOfflineIdleStatus = Effect.fn("status.queryOfflineIdleStatus")(
  function* (flags: CliAuthLocationFlags) {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCliAuthConfig(flags, logLevel);
    return yield* getServerIdleStatus().pipe(
      Effect.provide(
        SqlitePersistence.layerConfigAttached.pipe(
          Layer.provide(ServerConfig.layer(config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
        ),
      ),
    );
  },
  Effect.mapError(
    (cause) =>
      new StatusOfflineUnavailableError({
        reason: failureMessage(cause),
      }),
  ),
);

const queryLiveIdleStatus = Effect.fn("status.queryLiveIdleStatus")(function* (
  flags: CliAuthLocationFlags,
  options: { readonly drain: boolean; readonly quiet: boolean },
) {
  const { drain } = options;
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
  if (Option.isNone(runtimeState)) {
    return yield* new StatusLiveServerUnavailableError({
      reason: "no persisted running-server state",
    });
  }

  return yield* Effect.gen(function* () {
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    return yield* withStatusCliSessionToken(environmentAuth, drain, (token) =>
      Effect.gen(function* () {
        const client = yield* makeLiveServerClient(runtimeState.value.origin);
        const headers = { authorization: `Bearer ${token}` };
        if (drain) {
          // The check runs from the waiting release against the running one, which may predate
          // the drain route; it still answers whether it is idle.
          yield* client.server
            .drain({ headers })
            .pipe(
              Effect.catch((error) =>
                options.quiet ||
                (HttpClientError.isHttpClientError(error) &&
                  error.reason._tag === "DecodeError" &&
                  error.reason.response.status === 404)
                  ? Effect.void
                  : Console.error(
                      `Could not ask the running server to drain: ${failureMessage(error)}`,
                    ),
              ),
            );
        }
        return yield* client.server.idleStatus({ headers });
      }),
    );
  }).pipe(
    Effect.provide(
      EnvironmentAuth.layerRuntime.pipe(
        Layer.provideMerge(FetchHttpClient.layer),
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
      ),
    ),
  );
});

export const idleStatusCommand = Command.make("idle", {
  ...authLocationFlags,
  json: jsonFlag,
  quiet: quietFlag,
  drain: drainFlag,
}).pipe(
  Command.withDescription("Report whether the running T3 Code server is safe to restart."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const attemptedLive = yield* Effect.result(
        queryLiveIdleStatus(flags, { drain: flags.drain, quiet: flags.quiet }),
      );
      const attempted =
        attemptedLive._tag === "Success"
          ? attemptedLive
          : yield* Effect.result(queryOfflineIdleStatus(flags));
      if (attempted._tag === "Failure") {
        yield* setExitCode(2);
        if (!flags.quiet) {
          const liveFailure =
            attemptedLive._tag === "Failure" ? `${failureMessage(attemptedLive.failure)}; ` : "";
          yield* Console.log(
            formatUnknownStatus({
              reason: `${liveFailure}offline fallback failed: ${failureMessage(attempted.failure)}`,
              json: flags.json,
            }),
          );
        }
        return;
      }

      const status = attempted.success;
      if (!status.idle) {
        yield* setExitCode(1);
      }
      if (!flags.quiet) {
        yield* Console.log(formatIdleStatus(status, { json: flags.json }));
      }
    }),
  ),
);
