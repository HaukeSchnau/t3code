import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  CommandId,
  isDelegatedAppThread,
  isListedThreadLineage,
  ThreadAskId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const DETECT_CONCURRENCY = 3;
// Later updates of a completed run (a checkpoint, a delegated cohort) repeat its status.
const SEEN_RUN_LIMIT = 2_000;
const FALLBACK_ASK = "Answer the agent's question";

class TurnEndAskDetector extends Context.Service<
  TurnEndAskDetector,
  {
    /** Asks the text-generation model whether the run's ending waits on the user. */
    readonly detect: (threadId: ThreadId, runId: RunId) => Effect.Effect<void>;
    /** Waits until no detection is running. */
    readonly drain: Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/orchestration-v2/TurnEndAskDetector") {}

export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const running = yield* FiberMap.make<RunId, void, never>();
  const permits = yield* Semaphore.make(DETECT_CONCURRENCY);
  const seen = new Set<RunId>();

  const classify = Effect.fn("TurnEndAskDetector.classify")(function* (
    threadId: ThreadId,
    runId: RunId,
  ) {
    const shell = yield* threads.getThreadShell(threadId);
    // Subagents and delegated children ask through their parent as subagent requests.
    if (
      shell === null ||
      shell.archivedAt !== null ||
      shell.deletedAt !== null ||
      !isListedThreadLineage(shell.lineage) ||
      isDelegatedAppThread(shell) ||
      shell.pendingRuntimeRequest !== null
    ) {
      return;
    }
    const { thread, runs, messages, turnItems } = yield* threads.getThreadRecords(
      threadId,
      ["runs", "messages", "turnItems"],
      {
        runIds: [runId],
        messageRunIds: [runId],
        messageRoles: ["assistant"],
        turnItemRunIds: [runId],
        turnItemTypes: ["run_interrupt_request"],
      },
    );
    const run = runs.find((candidate) => candidate.id === runId);
    if (
      run?.status !== "completed" ||
      run.completedAt === null ||
      turnItems.length > 0 ||
      thread.asks?.some(
        (ask) =>
          (ask.source.type === "turn_end" && ask.source.runId === runId) ||
          // The run set a page's ask; its ending repeats that question, even once the user
          // answered or dismissed it. A withdrawn ask leaves the ending free to ask something else.
          (ask.source.type === "page" && ask.status !== "withdrawn" && ask.source.runId === runId),
      )
    ) {
      return;
    }
    const finalMessage = messages
      .filter((message) => !message.streaming && message.text.trim() !== "")
      .toSorted((left, right) => DateTime.Order(left.createdAt, right.createdAt))
      .at(-1);
    if (finalMessage === undefined) return;
    const latestUserMessage = yield* projections.getLatestUserReply(threadId);
    // The user already wrote again; the decider would drop the ask anyway.
    if (
      latestUserMessage !== undefined &&
      DateTime.isGreaterThan(latestUserMessage.createdAt, run.completedAt)
    ) {
      return;
    }
    const project = yield* projects.get(thread.projectId);
    if (Option.isNone(project)) return;

    const settings = yield* serverSettings.getSettings;
    const generated = yield* textGeneration.generateTurnEndAsk({
      cwd: thread.worktreePath ?? project.value.workspaceRoot,
      finalMessage: finalMessage.text,
      userMessage: latestUserMessage?.text,
      modelSelection: resolveProjectSettings(settings, thread.projectId).settings
        .textGenerationModelSelection,
      projectId: thread.projectId,
    });
    if (!generated.waitsOnUser) return;

    yield* threads.dispatch({
      type: "thread.ask.raise",
      commandId: CommandId.make(`thread-ask:turn-end:${runId}`),
      threadId,
      askId: ThreadAskId.make(`turn_end:${runId}`),
      source: { type: "turn_end", runId },
      text: generated.ask === "" ? FALLBACK_ASK : generated.ask,
    });
  });

  const detect: TurnEndAskDetector["Service"]["detect"] = (threadId, runId) =>
    Effect.suspend(() => {
      if (seen.has(runId)) return Effect.void;
      seen.add(runId);
      if (seen.size > SEEN_RUN_LIMIT) seen.delete(seen.values().next().value!);
      return FiberMap.run(
        running,
        runId,
        permits
          .withPermit(classify(threadId, runId))
          .pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.logWarning("Turn-end ask detection failed", { threadId, runId, cause }),
            ),
          ),
      ).pipe(Effect.asVoid);
    });

  const start: TurnEndAskDetector["Service"]["start"] = Effect.fn("TurnEndAskDetector.start")(
    function* () {
      yield* forkParked(
        Stream.runForEach(threads.streamDomainEvents, (event) =>
          event.type === "run.updated" && event.payload.status === "completed"
            ? detect(event.threadId, event.payload.id)
            : Effect.void,
        ).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning("Turn-end ask event stream failed", { cause }),
          ),
        ),
      );
    },
  );

  return TurnEndAskDetector.of({ detect, drain: FiberMap.awaitEmpty(running), start });
});
