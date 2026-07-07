import {
  AuthAdministrativeScopes,
  EnvironmentHttpApi,
  type ServerIdleStatus,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import { Command, Flag, GlobalFlag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { authLocationFlags, type CliAuthLocationFlags, resolveCliAuthConfig } from "./config.ts";

class StatusLiveServerUnavailableError extends Data.TaggedError(
  "StatusLiveServerUnavailableError",
)<{
  readonly reason: string;
}> {
  override get message(): string {
    return this.reason;
  }
}

const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const quietFlag = Flag.boolean("quiet").pipe(
  Flag.withDescription("Suppress output and use the exit code only."),
  Flag.withDefault(false),
);

const makeLiveServerClient = (origin: string) =>
  HttpApiClient.make(EnvironmentHttpApi, {
    baseUrl: origin,
  });

const withStatusCliSessionToken = <A, E, R>(
  environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"],
  run: (token: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    environmentAuth.issueSession({
      scopes: AuthAdministrativeScopes,
      label: "t3 status cli",
    }),
    (issued) => run(issued.token),
    (issued) => environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
  );

function formatIdleStatus(status: ServerIdleStatus, options: { readonly json: boolean }): string {
  if (options.json) {
    return JSON.stringify(status);
  }
  if (status.idle) {
    return "T3 Code is idle.";
  }
  const reasons = status.busyThreads
    .slice(0, 5)
    .map((thread) => `${thread.threadId}: ${thread.reason}`)
    .join("\n");
  return reasons.length > 0 ? `T3 Code is busy:\n${reasons}` : "T3 Code is busy.";
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

const queryLiveIdleStatus = (flags: CliAuthLocationFlags) =>
  Effect.gen(function* () {
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
      return yield* withStatusCliSessionToken(environmentAuth, (token) =>
        Effect.gen(function* () {
          const client = yield* makeLiveServerClient(runtimeState.value.origin);
          return yield* client.server.idleStatus({
            headers: { authorization: `Bearer ${token}` },
          });
        }),
      );
    }).pipe(
      Effect.provide(
        EnvironmentAuth.runtimeLayer.pipe(
          Layer.provideMerge(FetchHttpClient.layer),
          Layer.provide(ServerConfig.layer(config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
        ),
      ),
    );
  });

const idleStatusCommand = Command.make("idle", {
  ...authLocationFlags,
  json: jsonFlag,
  quiet: quietFlag,
}).pipe(
  Command.withDescription("Report whether the running T3 Code server is safe to restart."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const attempted = yield* Effect.result(queryLiveIdleStatus(flags));
      if (attempted._tag === "Failure") {
        yield* setExitCode(2);
        if (!flags.quiet) {
          yield* Console.log(
            formatUnknownStatus({
              reason:
                typeof attempted.failure === "object" &&
                attempted.failure !== null &&
                "message" in attempted.failure &&
                typeof attempted.failure.message === "string"
                  ? attempted.failure.message
                  : "probe failed",
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

export const statusCommand = Command.make("status").pipe(
  Command.withDescription("Inspect local T3 Code server status."),
  Command.withSubcommands([idleStatusCommand]),
);
