import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  askedRunId,
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
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as NeedsYouLedger from "../agentAwareness/NeedsYouLedger.ts";
import { NEEDS_YOU_ALERT_WINDOW_MS } from "../agentAwareness/needsYouRules.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const DETECT_CONCURRENCY = 3;
const FALLBACK_ASK = "Answer the agent's question";
/** A failed read is tried again while an ask raised from it would still alert: 7.5 minutes. */
const RETRY = Schedule.exponential("30 seconds").pipe(Schedule.upTo({ times: 4 }));

/** The turn-end ask of a run; one per run. */
const turnEndAskId = (runId: RunId) => ThreadAskId.make(`turn_end:${runId}`);

class TurnEndAskDetector extends Context.Service<
  TurnEndAskDetector,
  {
    /** Asks the text-generation model whether the run's ending waits on the user. */
    readonly detect: (threadId: ThreadId, runId: RunId) => Effect.Effect<void>;
    /**
     * Reads the completed runs the needs-you ledger recorded (`needs_you_checks`) and nobody read
     * within the alert window, such as across a deploy.
     */
    readonly recover: Effect.Effect<void>;
    /** Waits until no detection is running. */
    readonly drain: Effect.Effect<void>;
    /** Once the ledger is ready, recovers while it reads each completed run the ledger records. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/orchestration-v2/TurnEndAskDetector") {}

export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const ledger = yield* NeedsYouLedger.NeedsYouLedger;
  const running = yield* FiberMap.make<RunId, void, never>();
  const permits = yield* Semaphore.make(DETECT_CONCURRENCY);

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
      isDelegatedAppThread(shell)
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
      // The run set a page's ask; its ending repeats that question, even once the user answered
      // or dismissed it. A withdrawn ask leaves the ending free to ask something else.
      thread.asks?.some((ask) => askedRunId(ask) === runId)
    ) {
      return;
    }
    // Every question or card the ending waited on, not the shell's summary, which a later run's
    // approval takes over. As in the shell, a secret card asks while its run is live, a link card
    // until the user writes after it; one the user answered after the run ended still asked then.
    const waiting = yield* threads.getThreadRecords(
      threadId,
      ["runs", "runtimeRequests", "turnItems"],
      {
        runStatuses: ThreadManagementService.ACTIVE_RUN_STATUSES,
        runtimeRequestStatuses: ["pending"],
        turnItemTypes: ["secret_request", "link_request"],
      },
    );
    const endedAt = run.completedAt;
    const before = (at: DateTime.Utc) => !DateTime.isGreaterThan(at, endedAt);
    const wrote = shell.latestUserAuthoredMessageAt ?? null;
    const liveRunIds = new Set(waiting.runs.map((live) => live.id));
    if (
      waiting.runtimeRequests.some(
        (request) => request.kind !== "auth_refresh" && before(request.createdAt),
      ) ||
      waiting.turnItems.some((card) => {
        const asked = card.startedAt ?? card.updatedAt;
        const open =
          card.status === "waiting" || (card.completedAt !== null && !before(card.completedAt));
        return (
          card.nodeId !== null &&
          before(asked) &&
          (card.type === "secret_request"
            ? card.status === "waiting" && card.runId !== null && liveRunIds.has(card.runId)
            : open && (wrote === null || !DateTime.isGreaterThan(wrote, asked)))
        );
      })
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
      askId: turnEndAskId(runId),
      source: { type: "turn_end", runId },
      text: generated.ask === "" ? FALLBACK_ASK : generated.ask,
    });
    return;
  });

  /**
   * Reads the run once: the check is marked done only after the read and any raise succeeded, so
   * a failure is tried again within the window and on the next start. Each step is tried again on
   * its own, so a failed mark does not read the run again.
   */
  const detect: TurnEndAskDetector["Service"]["detect"] = (threadId, runId) =>
    FiberMap.run(
      running,
      runId,
      Effect.gen(function* () {
        if (yield* ledger.isChecked(runId).pipe(Effect.retry(RETRY))) return;
        yield* permits.withPermit(classify(threadId, runId)).pipe(Effect.retry(RETRY));
        yield* ledger.markChecked(runId).pipe(Effect.retry(RETRY));
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("Turn-end ask detection failed", { threadId, runId, cause }),
        ),
      ),
      { onlyIfMissing: true },
    ).pipe(Effect.asVoid);

  // A failed read is tried again with the window's start as it is then.
  const recover = Effect.gen(function* () {
    const since = DateTime.toEpochMillis(yield* DateTime.now) - NEEDS_YOU_ALERT_WINDOW_MS;
    for (const check of yield* ledger.pendingChecks(since)) {
      yield* detect(check.threadId, check.runId);
    }
  }).pipe(
    Effect.retry(RETRY),
    Effect.catchCause((cause) => Effect.logWarning("Turn-end ask recovery failed", { cause })),
    Effect.withSpan("TurnEndAskDetector.recover"),
  );

  const start: TurnEndAskDetector["Service"]["start"] = Effect.fn("TurnEndAskDetector.start")(
    function* () {
      yield* forkParked(
        Effect.gen(function* () {
          yield* ledger.ready;
          const added = yield* PubSub.subscribe(ledger.checksAdded);
          // New checks do not wait while a failed backlog read is tried again.
          yield* Effect.all(
            [
              recover,
              Stream.runForEach(Stream.fromSubscription(added), (check) =>
                detect(check.threadId, check.runId),
              ),
            ],
            { concurrency: "unbounded", discard: true },
          );
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning("Turn-end ask detection stopped", { cause }),
          ),
        ),
      );
    },
  );

  return TurnEndAskDetector.of({
    detect,
    recover,
    drain: FiberMap.awaitEmpty(running),
    start,
  });
});
