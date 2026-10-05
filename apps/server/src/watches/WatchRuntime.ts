import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const BATCH_WINDOW = Duration.millis(200);
const MAX_BATCH_CHARS = 3_000;
// A CLI report often exceeds 64 short lines. Keep its burst together before
// applying the character budget.
const MAX_BATCH_LINES = 1_024;

export type WatchLines = readonly [string, ...string[]];

/** Trims and drops blank lines; one line may use the whole budget so compact JSON keeps its tail. */
export function boundWatchLines(lines: ReadonlyArray<string>): WatchLines | null {
  const bounded: string[] = [];
  let remaining = MAX_BATCH_CHARS;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0 || remaining <= 0) continue;
    const accepted = line.slice(0, remaining);
    bounded.push(accepted);
    remaining -= accepted.length;
  }
  const [first, ...rest] = bounded;
  return first === undefined ? null : [first, ...rest];
}

/** Skips a burst identical to the previous one; A, B, A still reports every change. */
export function makeWatchChangeGate() {
  let previous: string | undefined;
  return (lines: WatchLines) => {
    const current = JSON.stringify(lines);
    if (current === previous) return false;
    previous = current;
    return true;
  };
}

/** Claude-compatible pacing: ten bursts, one restored every two seconds, overloaded after 30 seconds dry. */
export function makeWatchFloodGate() {
  let tokens = 10;
  let lastRefillAt: number | null = null;
  let overloadedAt: number | null = null;
  return (now: number): "accept" | "drop" | "overloaded" => {
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
  };
}

/**
 * Notes SIGTERM/SIGINT synchronously. A service manager can kill a watch command
 * before the server's own shutdown interrupts it, and that exit must not close
 * the durable watch.
 */
export const makeWatchShutdownGuard = Effect.fn("makeWatchShutdownGuard")(function* (
  signals: {
    on(event: string, listener: () => void): unknown;
    off(event: string, listener: () => void): unknown;
  } = process,
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
      Effect.suspend(() => (stopping ? Effect.void : Effect.asVoid(effect))),
  };
});

export type WatchCommandOutcome =
  | { readonly type: "exited"; readonly exitCode: number }
  | { readonly type: "failed"; readonly detail: string }
  | { readonly type: "stopped" };

// Platform errors wrap the OS error. Their own message repeats the command,
// which may carry credentials and must not reach the thread.
function osDetail(cause: Cause.Cause<unknown>, fallback: string): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.cause instanceof Error ? error.cause.message : fallback;
}

function shellCommand(command: string, cwd: string, platform: NodeJS.Platform) {
  const options = {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    killSignal: "SIGTERM",
    forceKillAfter: Duration.seconds(2),
  } as const;
  // An explicit sh keeps the whole command inside the project launcher prefix.
  return platform === "win32"
    ? ChildProcess.make(command, [], { ...options, shell: true })
    : ChildProcess.make("/bin/sh", ["-c", command], options);
}

/**
 * Runs a shell command until it exits, handing each burst of stdout and stderr
 * lines to `onBatch`. Returning false from `onBatch` stops the command.
 */
export const runWatchCommand = <R>(
  input: { readonly command: string; readonly cwd: string; readonly platform: NodeJS.Platform },
  onBatch: (lines: WatchLines) => Effect.Effect<boolean, never, R>,
): Effect.Effect<WatchCommandOutcome, never, ChildProcessSpawner.ChildProcessSpawner | R> =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawned = yield* Effect.exit(
        spawner.spawn(shellCommand(input.command, input.cwd, input.platform)),
      );
      if (Exit.isFailure(spawned)) {
        return {
          type: "failed",
          detail: `Could not start the command: ${osDetail(spawned.cause, "unknown error")}`,
        } as const;
      }
      const child = spawned.value;
      let stopped = false;
      const pumped = yield* Stream.merge(
        child.stdout.pipe(Stream.decodeText(), Stream.splitLines),
        child.stderr.pipe(Stream.decodeText(), Stream.splitLines),
      ).pipe(
        Stream.groupedWithin(MAX_BATCH_LINES, BATCH_WINDOW),
        Stream.map(boundWatchLines),
        Stream.filter((lines) => lines !== null),
        Stream.runForEachWhile((lines) =>
          onBatch(lines).pipe(
            Effect.tap((keepGoing) =>
              Effect.sync(() => {
                stopped = !keepGoing;
              }),
            ),
          ),
        ),
        Effect.exit,
      );
      if (stopped) return { type: "stopped" } as const;
      if (Exit.isFailure(pumped)) {
        return {
          type: "failed",
          detail: `Could not read the command output: ${osDetail(pumped.cause, "unknown error")}`,
        } as const;
      }
      const exitCode = yield* Effect.exit(child.exitCode);
      return Exit.isSuccess(exitCode)
        ? ({ type: "exited", exitCode: Number(exitCode.value) } as const)
        : ({
            type: "failed",
            detail: osDetail(exitCode.cause, "The command stopped unexpectedly."),
          } as const);
    }),
  );
