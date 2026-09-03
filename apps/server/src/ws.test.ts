import type { OrchestrationEvent, OrchestrationShellStreamItem } from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";

import {
  compactShellCursorItems,
  isThreadDetailEvent,
  shouldIncludeShellStreamItem,
} from "./ws.ts";

type ShellDeltaItem = Exclude<OrchestrationShellStreamItem, { readonly kind: "snapshot" }>;

const eventWithType = (type: OrchestrationEvent["type"]): OrchestrationEvent =>
  ({ type }) as OrchestrationEvent;

describe("isThreadDetailEvent", () => {
  it("streams queued message lifecycle events to active thread subscribers", () => {
    expect(isThreadDetailEvent(eventWithType("thread.message-queued"))).toBe(true);
    expect(isThreadDetailEvent(eventWithType("thread.queued-message-deleted"))).toBe(true);
    expect(isThreadDetailEvent(eventWithType("thread.queued-message-dispatched"))).toBe(true);
  });

  it("streams completed history prune events to active thread subscribers", () => {
    expect(isThreadDetailEvent(eventWithType("thread.history-pruned"))).toBe(true);
  });

  it("keeps non-detail orchestration events out of thread detail streams", () => {
    expect(isThreadDetailEvent(eventWithType("thread.turn-start-requested"))).toBe(false);
  });
});

describe("compactShellCursorItems", () => {
  it("never sends cursor items to version-skewed clients without the capability", () => {
    const cursor = { kind: "cursor" as const, sequence: 1 };
    expect(shouldIncludeShellStreamItem(cursor, undefined)).toBe(false);
    expect(shouldIncludeShellStreamItem(cursor, false)).toBe(false);
    expect(shouldIncludeShellStreamItem(cursor, true)).toBe(true);
  });

  effectIt.effect("bounds cursor traffic and flushes the finite catch-up tail", () =>
    Effect.gen(function* () {
      const cursors = Array.from({ length: 9_200 }, (_, index): ShellDeltaItem => ({
        kind: "cursor",
        sequence: index + 1,
      }));
      const output = yield* compactShellCursorItems(Stream.fromIterable(cursors)).pipe(
        Stream.runCollect,
      );

      expect(Array.from(output)).toHaveLength(72);
      expect(Array.from(output).at(-1)).toEqual({ kind: "cursor", sequence: 9_200 });
    }),
  );

  effectIt.effect("lets a visible item advance past pending cursors immediately", () =>
    Effect.gen(function* () {
      const visible = {
        kind: "project-removed" as const,
        sequence: 3,
        projectId: "project-1" as never,
      };
      const output = yield* compactShellCursorItems(
        Stream.fromIterable<ShellDeltaItem>([
          { kind: "cursor", sequence: 1 },
          { kind: "cursor", sequence: 2 },
          visible,
        ]),
      ).pipe(Stream.runCollect);

      expect(Array.from(output)).toEqual([visible]);
    }),
  );
});
