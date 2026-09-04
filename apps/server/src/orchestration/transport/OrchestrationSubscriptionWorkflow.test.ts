import {
  EventId,
  MessageId,
  OrchestrationShellSnapshot,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import type * as OrchestrationEngine from "../Services/OrchestrationEngine.ts";
import type * as ProjectionSnapshotMaterializer from "../Services/ProjectionSnapshotMaterializer.ts";
import type * as ProjectionSnapshotQuery from "../Services/ProjectionSnapshotQuery.ts";
import type * as ReplayLogPublisher from "../../observability/ReplayLogPublisher.ts";
import { LIVE_STREAM_MAX_ITEMS } from "../LiveStreamBudget.ts";
import { makeOrchestrationSubscriptionWorkflow } from "./OrchestrationSubscriptionWorkflow.ts";

const threadId = ThreadId.make("thread-slow-client");
const now = "2026-01-01T00:00:00.000Z";

function makeMessageEvent(sequence: number): OrchestrationEvent {
  return {
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: now,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.message-sent",
    payload: {
      threadId,
      messageId: MessageId.make(`message-${sequence}`),
      role: "assistant",
      text: `message-${sequence}`,
      turnId: TurnId.make("turn-1"),
      streaming: false,
      createdAt: now,
      updatedAt: now,
    },
  };
}

function makeEngine(input: {
  readonly liveEvents: PubSub.PubSub<OrchestrationEvent>;
  readonly attached: Deferred.Deferred<void>;
  readonly detached: Deferred.Deferred<void>;
}): OrchestrationEngine.OrchestrationEngineShape {
  return {
    readEvents: () => Stream.empty,
    dispatch: () => Effect.dieMessage("unexpected dispatch"),
    resolveReceipt: () => Effect.succeed(Option.none()),
    latestSequence: Effect.succeed(0),
    streamDomainEvents: Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(input.liveEvents);
        yield* Deferred.succeed(input.attached, undefined);
        return Stream.fromSubscription(subscription);
      }),
    ).pipe(Stream.ensuring(Deferred.succeed(input.detached, undefined))),
  };
}

const shellSnapshot = OrchestrationShellSnapshot.make({
  snapshotSequence: 0,
  projects: [],
  threads: [],
  usageLimits: [],
  updatedAt: now,
});

const projectionSnapshotQuery = {
  getShellSnapshot: () => Effect.succeed(shellSnapshot),
} as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQueryShape;

const projectionSnapshotMaterializer = {
  getSnapshot: () => Effect.dieMessage("unexpected snapshot materialization"),
  getShellSnapshot: () => Effect.dieMessage("unexpected shell materialization"),
  getThreadDetailSnapshot: () => Effect.dieMessage("unexpected thread materialization"),
} satisfies ProjectionSnapshotMaterializer.ProjectionSnapshotMaterializerShape;

const replayLogPublisher: ReplayLogPublisher.ReplayLogPublisher["Service"] = {
  publish: () => Effect.succeed(true),
};

describe("OrchestrationSubscriptionWorkflow", () => {
  for (const kind of ["shell", "thread"] as const) {
    it.effect(`stops an overflowing ${kind} producer before the client pulls again`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const liveEvents = yield* PubSub.unbounded<OrchestrationEvent>();
          const attached = yield* Deferred.make<void>();
          const detached = yield* Deferred.make<void>();
          const workflow = makeOrchestrationSubscriptionWorkflow({
            orchestrationEngine: makeEngine({ liveEvents, attached, detached }),
            projectionSnapshotQuery,
            projectionSnapshotMaterializer,
            replayLogPublisher,
          });
          const stream = yield* kind === "shell"
            ? workflow.subscribeShell({})
            : workflow.subscribeThread({ threadId, afterSequence: 0 });
          yield* Deferred.await(attached);

          yield* PubSub.publishAll(
            liveEvents,
            Array.from({ length: LIVE_STREAM_MAX_ITEMS + 1 }, (_, index) =>
              makeMessageEvent(index + 1),
            ),
          );
          yield* Deferred.await(detached);

          const result = yield* Stream.runDrain(stream).pipe(Effect.result);
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") {
            expect(result.failure._tag).toBe("OrchestrationGetSnapshotError");
          }
          expect(yield* PubSub.size(liveEvents)).toBe(0);
        }),
      ),
    );
  }
});
