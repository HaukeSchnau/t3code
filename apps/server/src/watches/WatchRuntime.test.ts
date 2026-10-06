import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import {
  boundWatchLines,
  makeWatchChangeGate,
  makeWatchFloodGate,
  runWatchCommand,
  type WatchLines,
} from "./WatchRuntime.ts";

describe("boundWatchLines", () => {
  it("drops blank lines and caps a burst at 3,000 characters", () => {
    assert.deepEqual(boundWatchLines(["  one ", "", "   ", "two"]), ["one", "two"]);
    assert.isNull(boundWatchLines(["", "  "]));
    const bounded = boundWatchLines(["a".repeat(2_990), "b".repeat(20), "c"]);
    assert.deepEqual(bounded, ["a".repeat(2_990), "b".repeat(10)]);
  });

  it("lets one compact JSON line use the whole budget", () => {
    const json = `{"status":"${"x".repeat(2_980)}","done":true}`;
    assert.deepEqual(boundWatchLines([json]), [json.slice(0, 3_000)]);
  });
});

it("skips only a burst identical to the one before it", () => {
  const changed = makeWatchChangeGate();
  assert.isTrue(changed(["a"]));
  assert.isFalse(changed(["a"]));
  assert.isTrue(changed(["b"]));
  assert.isTrue(changed(["a"]));
});

it("paces bursts and reports sustained overload after 30 seconds", () => {
  const pace = makeWatchFloodGate();
  const first = Array.from({ length: 10 }, () => pace(0));
  assert.deepEqual(first, Array(10).fill("accept"));
  assert.equal(pace(0), "drop");
  // One token comes back every two seconds; constant pressure never refills the bucket.
  for (let now = 2_000; now < 30_000; now += 2_000) {
    assert.equal(pace(now), "accept");
    assert.equal(pace(now), "drop");
  }
  assert.equal(pace(30_000), "overloaded");
});

describe("runWatchCommand", () => {
  const collect = (command: string, keepGoing = true) =>
    Effect.gen(function* () {
      const batches = yield* Ref.make<ReadonlyArray<WatchLines>>([]);
      const outcome = yield* runWatchCommand(
        { command, cwd: process.cwd(), platform: "linux" },
        (lines) => Ref.update(batches, (all) => [...all, lines]).pipe(Effect.as(keepGoing)),
      );
      return { outcome, batches: yield* Ref.get(batches) };
    }).pipe(Effect.provide(NodeServices.layer));

  it.live("delivers stdout and stderr lines and reports the exit code", () =>
    Effect.gen(function* () {
      const { outcome, batches } = yield* collect("printf 'one\\ntwo\\n'; echo three >&2; exit 3");
      assert.deepEqual(outcome, { type: "exited", exitCode: 3 });
      assert.sameMembers(batches.flat(), ["one", "two", "three"]);
    }),
  );

  it.live("stops the command when the batch handler declines more output", () =>
    Effect.gen(function* () {
      const { outcome, batches } = yield* collect("echo ready; exec sleep 600", false);
      assert.deepEqual(outcome, { type: "stopped" });
      assert.deepEqual(batches, [["ready"]]);
    }),
  );

  it.live("reports a missing working directory without the command text", () =>
    Effect.gen(function* () {
      const outcome = yield* runWatchCommand(
        { command: "echo SECRET-TOKEN", cwd: "/nonexistent/watch-cwd", platform: "linux" },
        () => Effect.succeed(true),
      ).pipe(Effect.provide(NodeServices.layer));
      assert.equal(outcome.type, "failed");
      assert.notInclude(outcome.type === "failed" ? outcome.detail : "", "SECRET-TOKEN");
    }),
  );
});
