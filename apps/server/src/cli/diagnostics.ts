import {
  AuthAdministrativeScopes,
  EnvironmentHttpApi,
  type WorkloadDiagnosticsSnapshot,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { authLocationFlags, type CliAuthLocationFlags, resolveCliAuthConfig } from "./config.ts";

class DiagnosticsLiveServerUnavailableError extends Data.TaggedError(
  "DiagnosticsLiveServerUnavailableError",
)<{
  readonly reason: string;
}> {
  override get message(): string {
    return this.reason;
  }
}

const encodeJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const makeLiveServerClient = (origin: string) =>
  HttpApiClient.make(EnvironmentHttpApi, {
    baseUrl: origin,
  });

const withDiagnosticsCliSessionToken = <A, E, R>(
  environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"],
  run: (token: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    environmentAuth.issueSession({
      scopes: AuthAdministrativeScopes,
      label: "t3 diagnostics cli",
    }),
    (issued) => run(issued.token),
    (issued) => environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
  );

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
  return "diagnostics command failed";
}

export function formatWorkloadDiagnosticsResult(
  result: WorkloadDiagnosticsSnapshot,
  options: { readonly json: boolean },
): string {
  if (options.json) return encodeJsonString(result);

  const nonZeroCounters = Object.entries(result.counters)
    .filter(([, value]) => value > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  const nonZeroGauges = Object.entries(result.gauges)
    .filter(([, value]) => value > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  return [
    `Workload diagnostics since ${result.startedAtIso}.`,
    ...nonZeroCounters.map(([name, value]) => `${name}: ${value}`),
    ...nonZeroGauges.map(([name, value]) => `${name}: ${value}`),
  ].join("\n");
}

const readLiveWorkloadDiagnostics = (flags: CliAuthLocationFlags) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCliAuthConfig(flags, logLevel);
    const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(runtimeState)) {
      return yield* new DiagnosticsLiveServerUnavailableError({
        reason: "no persisted running-server state",
      });
    }

    return yield* Effect.gen(function* () {
      const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
      return yield* withDiagnosticsCliSessionToken(environmentAuth, (token) =>
        Effect.gen(function* () {
          const client = yield* makeLiveServerClient(runtimeState.value.origin);
          return yield* client.server.workloadDiagnostics({
            headers: { authorization: `Bearer ${token}` },
          });
        }),
      );
    }).pipe(
      Effect.provide(
        EnvironmentAuth.runtimeLayer.pipe(
          Layer.provideMerge(FetchHttpClient.layer),
          Layer.provide(ServerConfig.layer(config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, "None")),
        ),
      ),
    );
  });

const workloadDiagnosticsCommand = Command.make("workload", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Read cumulative server workload amplification counters."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const attempted = yield* Effect.result(readLiveWorkloadDiagnostics(flags));
      if (attempted._tag === "Failure") {
        yield* setExitCode(2);
        const message = failureMessage(attempted.failure);
        yield* Console.error(flags.json ? encodeJsonString({ status: "error", message }) : message);
        return;
      }
      yield* Console.log(formatWorkloadDiagnosticsResult(attempted.success, { json: flags.json }));
    }),
  ),
);

export const diagnosticsCommand = Command.make("diagnostics").pipe(
  Command.withDescription("Inspect local T3 Code diagnostics."),
  Command.withSubcommands([workloadDiagnosticsCommand]),
);
