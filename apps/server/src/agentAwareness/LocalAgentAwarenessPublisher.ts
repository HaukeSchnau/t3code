import type { ThreadId } from "@t3tools/contracts";
import { type AgentAwarenessState, projectThreadAwarenessV2 } from "@t3tools/shared/agentAwareness";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import {
  makeAgentAwarenessPublishWorker,
  resolveAgentAwarenessRelayActiveThreadIds,
  shouldPublishAgentAwarenessEvent,
} from "../relay/AgentAwarenessRelay.ts";
import { forkParked } from "../serverActivation.ts";
import * as LocalAgentAwareness from "./LocalAgentAwareness.ts";

const CONFIRMATION_DELAY_MS = 5_000;

function publishIdentity(state: AgentAwarenessState): string {
  const { updatedAt: _updatedAt, ...meaningful } = state;
  return JSON.stringify(meaningful);
}

/**
 * Feeds paired devices from V2 thread events. Mirrors the relay publisher's rules: only work
 * finished by this process may raise a first terminal alert, and a tombstone or a first
 * "completed" state is published only if the projection still holds it five seconds later,
 * because both appear transiently while a session boots or the projector is mid-write.
 */
export const make = Effect.gen(function* () {
  const awareness = yield* LocalAgentAwareness.LocalAgentAwareness;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const scope = yield* Effect.scope;
  const startedAt = (yield* DateTime.now).epochMilliseconds;
  const published = new Map<ThreadId, string>();
  const confirmationDeadlines = new Map<ThreadId, number>();
  let scheduleConfirmation: (threadId: ThreadId) => Effect.Effect<void> = () => Effect.void;

  const publishSnapshot = Effect.fn("LocalAgentAwarenessPublisher.publishSnapshot")(function* (
    threadId: ThreadId,
  ) {
    const shell = yield* threads.getThreadShell(threadId);
    const thread = shell === null || shell.archivedAt !== null ? null : shell;
    const project = thread === null ? Option.none() : yield* projects.getById(thread.projectId);
    const state =
      thread === null || Option.isNone(project)
        ? null
        : projectThreadAwarenessV2({
            environmentId: yield* serverEnvironment.getEnvironmentId,
            project: project.value,
            thread,
          });
    const previous = published.get(threadId);
    if (state === null && previous === undefined) return;
    if (
      (state?.phase === "completed" || state?.phase === "failed") &&
      previous === undefined &&
      (thread?.latestRunCompletedAt == null ||
        DateTime.toEpochMillis(thread.latestRunCompletedAt) <= startedAt)
    ) {
      return;
    }
    const identity = state === null ? undefined : publishIdentity(state);
    if (identity === previous) {
      confirmationDeadlines.delete(threadId);
      return;
    }
    if (state === null || (state.phase === "completed" && previous === undefined)) {
      const now = (yield* DateTime.now).epochMilliseconds;
      const deadline = confirmationDeadlines.get(threadId);
      if (deadline === undefined) {
        confirmationDeadlines.set(threadId, now + CONFIRMATION_DELAY_MS);
        return yield* scheduleConfirmation(threadId);
      }
      if (now < deadline) return;
    }
    confirmationDeadlines.delete(threadId);
    yield* awareness.publish({ threadId, state });
    if (identity === undefined) published.delete(threadId);
    else published.set(threadId, identity);
  });

  const worker = yield* makeAgentAwarenessPublishWorker((threadId: ThreadId) =>
    publishSnapshot(threadId).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("accountless agent activity publish failed", { threadId, cause }),
      ),
    ),
  );
  scheduleConfirmation = (threadId) =>
    Effect.sleep(CONFIRMATION_DELAY_MS).pipe(
      Effect.andThen(worker.enqueue(threadId)),
      Effect.forkIn(scope),
      Effect.asVoid,
    );

  const publishActiveThreads = Effect.gen(function* () {
    const [projectSnapshot, shellSnapshot] = yield* Effect.all([
      projects.snapshot,
      threads.getShellSnapshot(),
    ]);
    const activeThreadIds = resolveAgentAwarenessRelayActiveThreadIds({
      environmentId: yield* serverEnvironment.getEnvironmentId,
      startedAt,
      projects: projectSnapshot.projects,
      threads: shellSnapshot.threads,
    });
    yield* Effect.forEach(activeThreadIds, worker.enqueue, { discard: true });
  });

  return {
    publishThread: (threadId: ThreadId) =>
      worker.enqueue(threadId).pipe(Effect.andThen(worker.drain)),
    drain: worker.drain,
    start: Effect.gen(function* () {
      yield* forkParked(
        publishActiveThreads.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("accountless agent activity snapshot failed", { cause }),
          ),
        ),
      );
      yield* forkParked(
        Stream.runForEach(threads.streamDomainEvents, (event) =>
          shouldPublishAgentAwarenessEvent(event) ? worker.enqueue(event.threadId) : Effect.void,
        ),
      );
    }),
  };
});

export const layer = Layer.effectDiscard(make.pipe(Effect.flatMap((publisher) => publisher.start)));
