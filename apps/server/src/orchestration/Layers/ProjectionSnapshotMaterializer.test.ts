import { ThreadId, type OrchestrationShellSnapshot } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

import { PersistenceSqlError } from "../../persistence/Errors.ts";
import {
  OrchestrationProjectionSnapshotMaterializerLive,
  makeProjectionSnapshotMaterializer,
  type ProjectionSnapshotFlightObservation,
} from "./ProjectionSnapshotMaterializer.ts";
import { ProjectionSnapshotMaterializer } from "../Services/ProjectionSnapshotMaterializer.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";

const shellSnapshot = (snapshotSequence: number): OrchestrationShellSnapshot => ({
  snapshotSequence,
  projects: [],
  threads: [],
  usageLimits: [],
  updatedAt: "2026-07-17T13:00:00.000Z",
});

const materializerLayer = (
  overrides: Partial<ProjectionSnapshotQueryShape>,
  observeFlight?: (observation: ProjectionSnapshotFlightObservation) => Effect.Effect<void>,
) => {
  const queryLayer = Layer.mock(ProjectionSnapshotQuery)({
    getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 7 }),
    getShellSnapshot: () => Effect.succeed(shellSnapshot(7)),
    getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
    ...overrides,
  });
  return (
    observeFlight
      ? Layer.effect(
          ProjectionSnapshotMaterializer,
          makeProjectionSnapshotMaterializer(observeFlight),
        )
      : OrchestrationProjectionSnapshotMaterializerLive
  ).pipe(Layer.provide(queryLayer));
};

describe("ProjectionSnapshotMaterializer", () => {
  it.effect("coalesces concurrent shell snapshots for the same observed sequence", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const loadCount = yield* Ref.make(0);
      const sequenceCalls = yield* Ref.make(0);
      const allSequencesObserved = yield* Deferred.make<void>();
      const layer = materializerLayer({
        getSnapshotSequence: () =>
          Ref.updateAndGet(sequenceCalls, (count) => count + 1).pipe(
            Effect.tap((count) =>
              count === 8 ? Deferred.succeed(allSequencesObserved, undefined) : Effect.void,
            ),
            Effect.as({ snapshotSequence: 7 }),
          ),
        getShellSnapshot: () =>
          Effect.gen(function* () {
            yield* Ref.update(loadCount, (count) => count + 1);
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(allSequencesObserved);
            yield* Deferred.await(release);
            return shellSnapshot(7);
          }),
      });

      yield* Effect.gen(function* () {
        const materializer = yield* ProjectionSnapshotMaterializer;
        const fibers = yield* Effect.forEach(Array.from({ length: 8 }), () =>
          materializer.getShellSnapshot().pipe(Effect.forkChild),
        );
        yield* Deferred.await(allSequencesObserved);
        yield* Deferred.await(entered);
        assert.strictEqual(yield* Ref.get(loadCount), 1);
        yield* Deferred.succeed(release, undefined);
        const results = yield* Effect.forEach(fibers, Fiber.join, { concurrency: "unbounded" });
        assert.deepStrictEqual(
          results,
          Array.from({ length: 8 }, () => shellSnapshot(7)),
        );
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("keeps the shared loader alive when the first waiter is interrupted", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const interrupted = yield* Ref.make(false);
      const sequenceCalls = yield* Ref.make(0);
      const followerSequenceObserved = yield* Deferred.make<void>();
      const layer = materializerLayer({
        getSnapshotSequence: () =>
          Ref.updateAndGet(sequenceCalls, (count) => count + 1).pipe(
            Effect.tap((count) =>
              count === 2 ? Deferred.succeed(followerSequenceObserved, undefined) : Effect.void,
            ),
            Effect.as({ snapshotSequence: 7 }),
          ),
        getShellSnapshot: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(shellSnapshot(7)),
            Effect.onInterrupt(() => Ref.set(interrupted, true)),
          ),
      });

      yield* Effect.gen(function* () {
        const materializer = yield* ProjectionSnapshotMaterializer;
        const leader = yield* materializer.getShellSnapshot().pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(leader);
        const follower = yield* materializer.getShellSnapshot().pipe(Effect.forkChild);
        yield* Deferred.await(followerSequenceObserved);
        yield* Deferred.succeed(release, undefined);
        assert.deepStrictEqual(yield* Fiber.join(follower), shellSnapshot(7));
        assert.isFalse(yield* Ref.get(interrupted));
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("fans out failure once and retries after evicting the failed flight", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const followerAttached = yield* Deferred.make<void>();
      const loadCount = yield* Ref.make(0);
      const layer = materializerLayer(
        {
          getShellSnapshot: () =>
            Effect.gen(function* () {
              const attempt = yield* Ref.getAndUpdate(loadCount, (count) => count + 1);
              if (attempt === 0) {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
                return yield* new PersistenceSqlError({
                  operation: "ProjectionSnapshotMaterializer.test",
                  detail: "snapshot failed",
                });
              }
              return shellSnapshot(7);
            }),
        },
        (observation) =>
          !observation.leader && observation.key === "shell:7"
            ? Deferred.succeed(followerAttached, undefined)
            : Effect.void,
      );

      yield* Effect.gen(function* () {
        const materializer = yield* ProjectionSnapshotMaterializer;
        const first = yield* materializer.getShellSnapshot().pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(entered);
        const second = yield* materializer.getShellSnapshot().pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(followerAttached);
        assert.strictEqual(yield* Ref.get(loadCount), 1);
        yield* Deferred.succeed(release, undefined);
        assert.strictEqual((yield* Fiber.join(first))._tag, "Failure");
        assert.strictEqual((yield* Fiber.join(second))._tag, "Failure");
        assert.deepStrictEqual(yield* materializer.getShellSnapshot(), shellSnapshot(7));
        assert.strictEqual(yield* Ref.get(loadCount), 2);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("coalesces the same thread and sequence while isolating thread ids", () =>
    Effect.gen(function* () {
      const firstThread = ThreadId.make("thread-a");
      const secondThread = ThreadId.make("thread-b");
      const release = yield* Deferred.make<void>();
      const allSequencesObserved = yield* Deferred.make<void>();
      const twoLoadersEntered = yield* Deferred.make<void>();
      const sequenceCalls = yield* Ref.make(0);
      const loadCount = yield* Ref.make(0);
      const layer = materializerLayer({
        getSnapshotSequence: () =>
          Ref.updateAndGet(sequenceCalls, (count) => count + 1).pipe(
            Effect.tap((count) =>
              count === 3 ? Deferred.succeed(allSequencesObserved, undefined) : Effect.void,
            ),
            Effect.as({ snapshotSequence: 7 }),
          ),
        getThreadDetailSnapshot: () =>
          Effect.gen(function* () {
            const count = yield* Ref.updateAndGet(loadCount, (value) => value + 1);
            if (count === 2) yield* Deferred.succeed(twoLoadersEntered, undefined);
            yield* Deferred.await(allSequencesObserved);
            yield* Deferred.await(release);
            return Option.none();
          }),
      });

      yield* Effect.gen(function* () {
        const materializer = yield* ProjectionSnapshotMaterializer;
        const first = yield* materializer
          .getThreadDetailSnapshot(firstThread)
          .pipe(Effect.forkChild);
        const duplicate = yield* materializer
          .getThreadDetailSnapshot(firstThread)
          .pipe(Effect.forkChild);
        const distinct = yield* materializer
          .getThreadDetailSnapshot(secondThread)
          .pipe(Effect.forkChild);
        yield* Deferred.await(allSequencesObserved);
        yield* Deferred.await(twoLoadersEntered);
        assert.strictEqual(yield* Ref.get(loadCount), 2);
        yield* Deferred.succeed(release, undefined);
        yield* Effect.forEach([first, duplicate, distinct], Fiber.join);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("keeps overlapping sequence flights independent under reverse completion", () =>
    Effect.gen(function* () {
      const sequenceCalls = yield* Ref.make(0);
      const loadCalls = yield* Ref.make(0);
      const firstEntered = yield* Deferred.make<void>();
      const secondEntered = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const releaseSecond = yield* Deferred.make<void>();
      const layer = materializerLayer({
        getSnapshotSequence: () =>
          Ref.getAndUpdate(sequenceCalls, (count) => count + 1).pipe(
            Effect.map((call) => ({ snapshotSequence: call === 0 ? 7 : 8 })),
          ),
        getShellSnapshot: () =>
          Effect.gen(function* () {
            const call = yield* Ref.getAndUpdate(loadCalls, (count) => count + 1);
            if (call === 0) {
              yield* Deferred.succeed(firstEntered, undefined);
              yield* Deferred.await(releaseFirst);
              return shellSnapshot(7);
            }
            yield* Deferred.succeed(secondEntered, undefined);
            yield* Deferred.await(releaseSecond);
            return shellSnapshot(8);
          }),
      });

      yield* Effect.gen(function* () {
        const materializer = yield* ProjectionSnapshotMaterializer;
        const older = yield* materializer.getShellSnapshot().pipe(Effect.forkChild);
        yield* Deferred.await(firstEntered);
        const newer = yield* materializer.getShellSnapshot().pipe(Effect.forkChild);
        yield* Deferred.await(secondEntered);
        assert.strictEqual(yield* Ref.get(loadCalls), 2);
        yield* Deferred.succeed(releaseSecond, undefined);
        assert.deepStrictEqual(yield* Fiber.join(newer), shellSnapshot(8));
        yield* Deferred.succeed(releaseFirst, undefined);
        assert.deepStrictEqual(yield* Fiber.join(older), shellSnapshot(7));
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("interrupts a shared loader when its server layer scope closes", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const layer = materializerLayer({
        getShellSnapshot: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
          ),
      });
      const scope = yield* Scope.make();
      const context = yield* Layer.build(layer).pipe(Scope.provide(scope));
      const waiter = yield* ProjectionSnapshotMaterializer.pipe(
        Effect.flatMap((materializer) => materializer.getShellSnapshot()),
        Effect.provide(context),
        Effect.forkChild,
      );

      yield* Deferred.await(entered);
      yield* Scope.close(scope, Exit.void);
      yield* Deferred.await(interrupted);
      assert.strictEqual((yield* Fiber.await(waiter))._tag, "Failure");
    }),
  );

  it.effect("does not retain a completed missing-thread result", () =>
    Effect.gen(function* () {
      const loadCount = yield* Ref.make(0);
      const layer = materializerLayer({
        getThreadDetailSnapshot: () =>
          Ref.update(loadCount, (count) => count + 1).pipe(Effect.as(Option.none())),
      });

      yield* Effect.gen(function* () {
        const materializer = yield* ProjectionSnapshotMaterializer;
        const threadId = ThreadId.make("missing-thread");
        yield* materializer.getThreadDetailSnapshot(threadId);
        yield* materializer.getThreadDetailSnapshot(threadId);
        assert.strictEqual(yield* Ref.get(loadCount), 2);
      }).pipe(Effect.provide(layer));
    }),
  );
});
