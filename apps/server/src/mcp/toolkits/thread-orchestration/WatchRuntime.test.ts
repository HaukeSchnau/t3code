import { describe, expect, it } from "@effect/vitest";
import * as NodeEvents from "node:events";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

import {
  boundWatchEvents,
  makeWatchChangeGate,
  makeWatchFloodGate,
  makeWatchShutdownGuard,
  runWatchSource,
} from "./WatchRuntime.ts";

describe("watch shutdown and command failures", () => {
  for (const signal of ["SIGTERM", "SIGINT"]) {
    it.effect(`preserves watches after ${signal} and removes its listener`, () =>
      Effect.gen(function* () {
        const signals = new NodeEvents.EventEmitter();
        const closed: string[] = [];
        yield* Effect.scoped(
          Effect.gen(function* () {
            const guard = yield* makeWatchShutdownGuard(signals);
            yield* guard.unlessStopping(Effect.sync(() => closed.push("ordinary failure")));
            signals.emit(signal);
            yield* guard.unlessStopping(Effect.sync(() => closed.push("shutdown failure")));
            yield* guard.unlessStopping(Effect.sync(() => closed.push("shutdown completion")));
          }),
        );
        expect(closed).toEqual(["ordinary failure"]);
        expect(signals.listenerCount("SIGTERM")).toBe(0);
        expect(signals.listenerCount("SIGINT")).toBe(0);
      }),
    );
  }

  it.effect("reports a nonzero exit instead of completing successfully", () =>
    Effect.gen(function* () {
      const detail = yield* runWatchSource(
        { type: "shell", command: "exit 7" },
        process.cwd(),
        () => Effect.void,
      ).pipe(
        Effect.as("unexpected success"),
        Effect.catch((error) => Effect.succeed(error.detail)),
        Effect.provide(NodeServices.layer),
      );
      expect(detail).toBe("Watch command exited with code 7.");
    }),
  );

  it.effect("includes the signal when a command is terminated outside server shutdown", () =>
    Effect.gen(function* () {
      const detail = yield* runWatchSource(
        { type: "shell", command: "kill -TERM $$" },
        process.cwd(),
        () => Effect.void,
      ).pipe(
        Effect.as("unexpected success"),
        Effect.catch((error) => Effect.succeed(error.detail)),
        Effect.provide(NodeServices.layer),
      );
      expect(detail).toContain("SIGTERM");
    }),
  );
});

describe("durable watch event pacing", () => {
  it("ignores repeated snapshots while preserving transitions back to earlier states", () => {
    const changed = makeWatchChangeGate();
    expect(changed(["pending"])).toBe(true);
    expect(changed(["pending"])).toBe(false);
    expect(changed(["active"])).toBe(true);
    expect(changed(["pending"])).toBe(true);
  });
  it("bounds individual events and the combined batch", () => {
    const bounded = boundWatchEvents(["  first  ", "x".repeat(600), "y".repeat(3_000)]);

    expect(bounded?.[0]).toBe("first");
    expect(bounded?.[1]).toHaveLength(500);
    expect(bounded?.join("")).toHaveLength(1_005);
    expect(
      boundWatchEvents(Array.from({ length: 10 }, () => "z".repeat(500)))?.join(""),
    ).toHaveLength(3_000);
    expect(boundWatchEvents(["  ", "\n"])).toBeNull();
  });

  it("drops bursts before failing a source that overloads for thirty seconds", () => {
    const gate = makeWatchFloodGate();

    for (let index = 0; index < 10; index += 1) {
      expect(gate.accept(1_000)).toBe("accept");
    }
    expect(gate.accept(1_000)).toBe("drop");
    expect(gate.accept(30_999)).toBe("accept");

    const sustained = makeWatchFloodGate();
    for (let index = 0; index < 10; index += 1) sustained.accept(1_000);
    expect(sustained.accept(1_001)).toBe("drop");
    for (let now = 1_101; now < 31_001; now += 100) sustained.accept(now);
    expect(sustained.accept(31_001)).toBe("overloaded");
  });
});
