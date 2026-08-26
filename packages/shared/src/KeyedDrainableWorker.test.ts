import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import { makeKeyedDrainableWorker } from "./KeyedDrainableWorker.ts";

describe("makeKeyedDrainableWorker", () => {
  it.live("lets an independent key progress while another key is blocked", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const blockedStarted = yield* Deferred.make<void>();
        const releaseBlocked = yield* Deferred.make<void>();
        const independentProcessed = yield* Deferred.make<void>();

        const worker = yield* makeKeyedDrainableWorker<string, string, never, never>({
          concurrency: 2,
          process: (item) =>
            Effect.gen(function* () {
              if (item === "blocked") {
                yield* Deferred.succeed(blockedStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseBlocked);
              }
              if (item === "independent") {
                yield* Deferred.succeed(independentProcessed, undefined).pipe(Effect.orDie);
              }
            }),
        });

        yield* worker.enqueue("thread-a", "blocked");
        yield* Deferred.await(blockedStarted);
        yield* worker.enqueue("thread-b", "independent");
        yield* Deferred.await(independentProcessed);

        yield* Deferred.succeed(releaseBlocked, undefined);
        yield* worker.drain;
      }),
    ),
  );

  it.live("preserves FIFO within a key and drains work enqueued during processing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();

        const worker = yield* makeKeyedDrainableWorker<string, string, never, never>({
          concurrency: 4,
          process: (item) =>
            Effect.gen(function* () {
              if (item === "first") {
                yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseFirst);
              }
              processed.push(item);
            }),
        });

        yield* worker.enqueue("thread-a", "first");
        yield* Deferred.await(firstStarted);
        yield* worker.enqueue("thread-a", "second");
        yield* worker.enqueue("thread-a", "third");

        yield* Deferred.succeed(releaseFirst, undefined);
        yield* worker.drain;

        expect(processed).toEqual(["first", "second", "third"]);
      }),
    ),
  );

  it.live("replaces redundant queued tails without inflating outstanding work", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const worker = yield* makeKeyedDrainableWorker<string, string, never, never>({
          concurrency: 1,
          replacePendingTail: (pending, incoming) =>
            pending.startsWith("journal-") && incoming.startsWith("journal-"),
          process: (item) =>
            Effect.gen(function* () {
              processed.push(item);
              if (item === "first") {
                yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseFirst);
              }
            }),
        });

        yield* worker.enqueue("thread-a", "first");
        yield* Deferred.await(firstStarted);
        yield* Effect.forEach(
          Array.from({ length: 100 }, (_, index) => `journal-${index}`),
          (item) => worker.enqueue("thread-a", item),
          { discard: true },
        );
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* worker.drain;

        expect(processed).toEqual(["first", "journal-99"]);
      }),
    ),
  );
});
