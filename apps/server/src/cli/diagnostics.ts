import {
  ENERGY_DIAGNOSTICS_CAPTURE_WAIT_SLACK_MS,
  AuthAdministrativeScopes,
  EnvironmentHttpApi,
  type EnergyDiagnosticsCaptureResult,
  type WorkloadDiagnosticsSnapshot,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
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
import {
  authLocationFlags,
  type CliAuthLocationFlags,
  DurationFromString,
  resolveCliAuthConfig,
} from "./config.ts";

class DiagnosticsLiveServerUnavailableError extends Data.TaggedError(
  "DiagnosticsLiveServerUnavailableError",
)<{
  readonly reason: string;
}> {
  override get message(): string {
    return this.reason;
  }
}

class DiagnosticsInvalidCaptureInputError extends Data.TaggedError(
  "DiagnosticsInvalidCaptureInputError",
)<{
  readonly reason: string;
}> {
  override get message(): string {
    return this.reason;
  }
}

const MIN_DURATION_MS = 1_000;
const MAX_DURATION_MS = 300_000;
const MIN_WAIT_TIMEOUT_MS = 1_000;
const MAX_WAIT_TIMEOUT_MS = 600_000;
const encodeJsonString = Schema.encodeSync(Schema.UnknownFromJsonString);

const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const durationFlag = Flag.string("duration").pipe(
  Flag.withSchema(DurationFromString),
  Flag.withDescription("Capture duration, for example `5s`, `30s`, or `2 minutes`."),
  Flag.withDefault(Duration.seconds(30)),
);

const waitTimeoutFlag = Flag.string("wait-timeout").pipe(
  Flag.withSchema(DurationFromString),
  Flag.withDescription("Maximum time to wait for the renderer to finish the capture."),
  Flag.optional,
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

function durationMillis(
  duration: Duration.Duration,
  limits: {
    readonly min: number;
    readonly max: number;
    readonly label: string;
  },
) {
  const millis = Math.round(Duration.toMillis(duration));
  if (millis < limits.min || millis > limits.max) {
    return Effect.fail(
      new DiagnosticsInvalidCaptureInputError({
        reason: `${limits.label} must be between ${limits.min}ms and ${limits.max}ms.`,
      }),
    );
  }
  return Effect.succeed(millis);
}

function formatEnergyCaptureResult(
  result: EnergyDiagnosticsCaptureResult,
  options: { readonly json: boolean },
): string {
  if (options.json) {
    return encodeJsonString(result);
  }

  const lines = [
    `Energy diagnostics capture ${result.status}.`,
    `Request: ${result.requestId}`,
    `Duration: ${result.durationMs}ms`,
  ];
  if (result.artifactPath !== null) {
    lines.push(`Artifact: ${result.artifactPath}`);
  }
  if (result.message !== null) {
    lines.push(`Message: ${result.message}`);
  }
  if (result.status === "completed") {
    lines.push(
      `Samples: desktop=${result.desktopProcessSnapshotCount}, ipc=${result.ipcPressureSnapshotCount}, commits=${result.rendererCommitCount}, longTasks=${result.rendererLongTaskCount}`,
    );
  }
  return lines.join("\n");
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

const requestLiveEnergyCapture = (
  flags: {
    readonly duration: Duration.Duration;
    readonly waitTimeout: Option.Option<Duration.Duration>;
  } & CliAuthLocationFlags,
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCliAuthConfig(flags, logLevel);
    const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(runtimeState)) {
      return yield* new DiagnosticsLiveServerUnavailableError({
        reason: "no persisted running-server state",
      });
    }

    const durationMs = yield* durationMillis(flags.duration, {
      min: MIN_DURATION_MS,
      max: MAX_DURATION_MS,
      label: "duration",
    });
    const waitTimeoutMs = Option.isSome(flags.waitTimeout)
      ? yield* durationMillis(flags.waitTimeout.value, {
          min: MIN_WAIT_TIMEOUT_MS,
          max: MAX_WAIT_TIMEOUT_MS,
          label: "wait-timeout",
        })
      : undefined;
    if (
      waitTimeoutMs !== undefined &&
      waitTimeoutMs < durationMs + ENERGY_DIAGNOSTICS_CAPTURE_WAIT_SLACK_MS
    ) {
      return yield* new DiagnosticsInvalidCaptureInputError({
        reason: `wait-timeout must be at least the capture duration plus ${ENERGY_DIAGNOSTICS_CAPTURE_WAIT_SLACK_MS}ms.`,
      });
    }

    return yield* Effect.gen(function* () {
      const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
      return yield* withDiagnosticsCliSessionToken(environmentAuth, (token) =>
        Effect.gen(function* () {
          const client = yield* makeLiveServerClient(runtimeState.value.origin);
          return yield* client.server.requestEnergyCapture({
            headers: { authorization: `Bearer ${token}` },
            payload: {
              durationMs,
              ...(waitTimeoutMs === undefined ? {} : { waitTimeoutMs }),
            },
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

const energyDiagnosticsCommand = Command.make("energy", {
  ...authLocationFlags,
  duration: durationFlag,
  waitTimeout: waitTimeoutFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Record an energy diagnostics capture in the running T3 Code app."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const attempted = yield* Effect.result(requestLiveEnergyCapture(flags));
      if (attempted._tag === "Failure") {
        yield* setExitCode(2);
        const message = failureMessage(attempted.failure);
        yield* Console.error(flags.json ? encodeJsonString({ status: "error", message }) : message);
        return;
      }

      const result = attempted.success;
      if (result.status !== "completed") {
        yield* setExitCode(1);
      }
      yield* Console.log(formatEnergyCaptureResult(result, { json: flags.json }));
    }),
  ),
);

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
  Command.withDescription("Record and inspect local T3 Code diagnostics."),
  Command.withSubcommands([energyDiagnosticsCommand, workloadDiagnosticsCommand]),
);
