import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { ConnectionTransientError } from "./model.ts";
import {
  activeEnvironmentMode,
  environmentModeTargets,
  makeEnvironmentModes,
  nextEnvironmentMode,
  type EnvironmentMode,
} from "./environmentModes.ts";

const WORK = EnvironmentId.make("work");
const HOME = EnvironmentId.make("home");
const SHARED = EnvironmentId.make("shared");
const UNGROUPED = EnvironmentId.make("ungrouped");

const MODES: ReadonlyArray<EnvironmentMode> = [
  { id: "work", name: "Work", environmentIds: [WORK, SHARED] },
  { id: "personal", name: "Personal", environmentIds: [HOME, SHARED, EnvironmentId.make("gone")] },
];

function entries(enabled: ReadonlyArray<EnvironmentId>) {
  return new Map(
    [WORK, HOME, SHARED, UNGROUPED].map((id) => [id, { enabled: enabled.includes(id) }] as const),
  );
}

describe("environment modes", () => {
  it("switches members of other modes off and leaves ungrouped or unknown environments alone", () => {
    expect(environmentModeTargets(MODES, "work", entries([]))).toEqual(
      new Map([
        [WORK, true],
        [SHARED, true],
        [HOME, false],
      ]),
    );
    expect(environmentModeTargets(MODES, null, entries([]))).toEqual(
      new Map([
        [WORK, true],
        [SHARED, true],
        [HOME, true],
      ]),
    );
    expect(environmentModeTargets(MODES, "deleted", entries([]))).toEqual(new Map());
  });

  it("derives the active mode from the switches, ignoring ungrouped environments", () => {
    expect(activeEnvironmentMode(MODES, entries([WORK, SHARED, UNGROUPED]))).toBe("work");
    expect(activeEnvironmentMode(MODES, entries([HOME, SHARED]))).toBe("personal");
    expect(activeEnvironmentMode(MODES, entries([WORK, HOME, SHARED]))).toBeNull();
    expect(activeEnvironmentMode(MODES, entries([WORK]))).toBe("custom");
  });

  it("cycles through the modes, then all, and starts over from a custom state", () => {
    expect(nextEnvironmentMode(MODES, entries([WORK, SHARED]))).toBe("personal");
    expect(nextEnvironmentMode(MODES, entries([HOME, SHARED]))).toBeNull();
    expect(nextEnvironmentMode(MODES, entries([WORK, HOME, SHARED]))).toBe("work");
    expect(nextEnvironmentMode(MODES, entries([WORK]))).toBe("work");
  });

  it("skips a mode that would change nothing, so a mode matching all cannot trap the cycle", () => {
    const modes: ReadonlyArray<EnvironmentMode> = [
      { id: "work", name: "Work", environmentIds: [WORK] },
      { id: "everything", name: "Everything", environmentIds: [WORK, HOME] },
    ];
    expect(nextEnvironmentMode(modes, entries([WORK, HOME]))).toBe("work");
    expect(nextEnvironmentMode(modes.slice(0, 1), entries([WORK]))).toBe("work");
  });

  it.effect("reads storage on first use, retries a failed read, and never writes over it", () =>
    Effect.gen(function* () {
      const writes: Array<ReadonlyArray<EnvironmentMode>> = [];
      let reads = 0;
      const store = yield* makeEnvironmentModes({
        read: Effect.suspend(() =>
          ++reads === 1
            ? Effect.fail(
                new ConnectionTransientError({
                  reason: "transport",
                  detail: "catalog unavailable",
                }),
              )
            : Effect.succeed(MODES),
        ),
        write: (modes) => Effect.sync(() => void writes.push(modes)),
      });
      expect(reads).toBe(0);

      expect(yield* store.get).toEqual([]);
      expect(writes).toEqual([]);
      expect(yield* store.get).toEqual(MODES);
      yield* store.update((modes) => modes.slice(1));
      expect(writes).toEqual([MODES.slice(1)]);
      expect(reads).toBe(2);
    }),
  );
});
