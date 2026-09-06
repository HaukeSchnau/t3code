// @effect-diagnostics nodeBuiltinImport:off
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as NodeProcess from "node:process";

import type { OrchestrationWatchSource } from "@t3tools/contracts";

const BATCH_WINDOW = Duration.millis(200);
const MAX_EVENT_CHARS = 500;
const MAX_BATCH_CHARS = 3_000;

/** Mark shutdown synchronously, before child-process exit callbacks can close durable watches. */
export const makeWatchShutdownGuard = Effect.fn("makeWatchShutdownGuard")(function* (
  signals: {
    on(event: string, listener: () => void): unknown;
    off(event: string, listener: () => void): unknown;
  } = NodeProcess,
) {
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      signals.on("SIGTERM", stop);
      signals.on("SIGINT", stop);
    }),
    () =>
      Effect.sync(() => {
        stop();
        signals.off("SIGTERM", stop);
        signals.off("SIGINT", stop);
      }),
  );
  return {
    unlessStopping: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.suspend(() => {
        if (!stopping) return effect;
        // #region motel debug
        // TODO: Remove after the production restart verification is confirmed.
        return Effect.logInfo("Preserving durable watch during server shutdown", {
          "debug.session": "watch-shutdown",
          "debug.hypothesis": "shutdown-closes-watch",
          "debug.step": "skip-terminal-transition",
        });
        // #endregion motel debug
      }),
  };
});

/** Consecutive snapshots are unchanged; A → B → A still reports both changes. */
export function makeWatchChangeGate() {
  let previous: string | undefined;
  return (events: ReadonlyArray<string>) => {
    const current = JSON.stringify(events);
    if (current === previous) return false;
    previous = current;
    return true;
  };
}

export class WatchSourceError extends Schema.TaggedErrorClass<WatchSourceError>()(
  "WatchSourceError",
  { detail: Schema.String, retryable: Schema.Boolean, cause: Schema.optional(Schema.Defect()) },
) {}

export function boundWatchEvents(events: ReadonlyArray<string>): [string, ...string[]] | null {
  const bounded: string[] = [];
  let remaining = MAX_BATCH_CHARS;
  for (const raw of events) {
    const event = raw.trim().slice(0, MAX_EVENT_CHARS);
    if (event.length === 0 || remaining <= 0) continue;
    const accepted = event.slice(0, remaining);
    bounded.push(accepted);
    remaining -= accepted.length;
  }
  return bounded.length === 0 ? null : (bounded as [string, ...string[]]);
}

export interface WatchFloodGate {
  readonly accept: (now: number) => "accept" | "drop" | "overloaded";
}

/** Claude-compatible pacing: ten bursts, one token restored every two seconds. */
export function makeWatchFloodGate(): WatchFloodGate {
  let tokens = 10;
  let lastRefillAt: number | null = null;
  let overloadedAt: number | null = null;
  return {
    accept: (now) => {
      lastRefillAt ??= now;
      const refill = Math.floor((now - lastRefillAt) / 2_000);
      if (refill > 0) {
        tokens = Math.min(10, tokens + refill);
        lastRefillAt += refill * 2_000;
      }
      if (tokens === 10) overloadedAt = null;
      if (overloadedAt !== null && now - overloadedAt >= 30_000) return "overloaded";
      if (tokens > 0) {
        tokens -= 1;
        return "accept";
      }
      overloadedAt ??= now;
      return now - overloadedAt >= 30_000 ? "overloaded" : "drop";
    },
  };
}

const websocketStream = (url: string): Stream.Stream<string, WatchSourceError> =>
  Stream.callback<string, WatchSourceError>((queue) =>
    Effect.gen(function* () {
      const socket = yield* Effect.try({
        try: () => new WebSocket(url),
        catch: (cause) =>
          new WatchSourceError({
            detail: `Invalid WebSocket URL '${url}'.`,
            retryable: false,
            cause,
          }),
      });
      const fail = (error: WatchSourceError) => {
        Queue.failCauseUnsafe(queue, Cause.fail(error));
      };
      const onMessage = (event: MessageEvent) => {
        if (typeof event.data === "string") Queue.offerUnsafe(queue, event.data);
      };
      const onClose = () => {
        fail(new WatchSourceError({ detail: "WebSocket closed.", retryable: true }));
      };
      const onError = (cause: Event) => {
        fail(
          new WatchSourceError({
            detail: `WebSocket connection to '${url}' failed.`,
            retryable: true,
            cause,
          }),
        );
      };
      socket.addEventListener("message", onMessage);
      socket.addEventListener("close", onClose, { once: true });
      socket.addEventListener("error", onError, { once: true });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          socket.removeEventListener("message", onMessage);
          socket.removeEventListener("close", onClose);
          socket.removeEventListener("error", onError);
          socket.close();
        }),
      );
    }),
  );

const runWebSocket = (
  url: string,
  onBatch: (events: [string, ...string[]]) => Effect.Effect<void, WatchSourceError>,
): Effect.Effect<void, WatchSourceError> =>
  websocketStream(url).pipe(
    Stream.groupedWithin(64, BATCH_WINDOW),
    Stream.map((chunk) => boundWatchEvents([...chunk])),
    Stream.filter((events): events is [string, ...string[]] => events !== null),
    Stream.runForEach(onBatch),
    Effect.catch((error) =>
      error.retryable
        ? Effect.sleep(Duration.seconds(2)).pipe(
            Effect.andThen(Effect.suspend(() => runWebSocket(url, onBatch))),
          )
        : Effect.fail(error),
    ),
  );

export const runWatchSource = Effect.fn("runWatchSource")(function* (
  source: OrchestrationWatchSource,
  defaultCwd: string,
  onBatch: (events: [string, ...string[]]) => Effect.Effect<void, WatchSourceError>,
) {
  if (source.type === "websocket") {
    return yield* runWebSocket(source.url, onBatch);
  }

  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command =
    source.type === "process"
      ? ChildProcess.make(source.argv[0], source.argv.slice(1), {
          cwd: source.cwd ?? defaultCwd,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          killSignal: "SIGTERM",
          forceKillAfter: Duration.seconds(2),
        })
      : ChildProcess.make(source.command, [], {
          cwd: source.cwd ?? defaultCwd,
          shell: true,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          killSignal: "SIGTERM",
          forceKillAfter: Duration.seconds(2),
        });

  return yield* Effect.scoped(
    Effect.acquireRelease(
      spawner.spawn(command).pipe(
        Effect.mapError(
          (cause) =>
            new WatchSourceError({
              detail: "Could not start watch command.",
              retryable: false,
              cause,
            }),
        ),
      ),
      (child) => child.kill().pipe(Effect.ignore),
    ).pipe(
      Effect.flatMap((child) =>
        Effect.all(
          [
            child.stdout.pipe(
              Stream.decodeText(),
              Stream.splitLines,
              Stream.groupedWithin(64, BATCH_WINDOW),
              Stream.map((chunk) => boundWatchEvents([...chunk])),
              Stream.filter((events): events is [string, ...string[]] => events !== null),
              Stream.runForEach(onBatch),
            ),
            child.stderr.pipe(Stream.runDrain),
            child.exitCode.pipe(
              Effect.flatMap((code) =>
                code === 0
                  ? Effect.void
                  : Effect.fail(
                      new WatchSourceError({
                        detail: `Watch command exited with code ${code}.`,
                        retryable: false,
                      }),
                    ),
              ),
            ),
          ],
          { concurrency: "unbounded" },
        ),
      ),
      Effect.asVoid,
      Effect.mapError((cause) => {
        if (Schema.is(WatchSourceError)(cause)) return cause;
        // Platform errors wrap the OS error; their own message includes the command,
        // which may contain credentials and should not be copied into chat.
        const detail =
          cause instanceof Error && cause.cause instanceof Error
            ? cause.cause.message
            : "Process I/O failed.";
        return new WatchSourceError({
          detail: `Watch command failed: ${detail}`,
          retryable: false,
          cause,
        });
      }),
    ),
  );
});
