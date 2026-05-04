import {
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderRuntimeTurnCompletedEvent,
  type ProviderRuntimeTurnDiffUpdatedEvent,
  type ProviderRuntimeTurnStartedEvent,
} from "@t3tools/contracts";
import { Cause, Effect, Layer, Option, Stream } from "effect";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { parseTurnDiffFilesFromUnifiedDiff } from "../../checkpointing/Diffs.ts";
import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { JjCore } from "../../git/Services/JjCore.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import {
  VcsExternalDiffRepository,
  VcsTurnChangeRepository,
  type VcsTurnScopeState,
} from "../../persistence/Services/VcsTurnChanges.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  JjTurnChangeTracker,
  type JjTurnChangeTrackerShape,
} from "../Services/JjTurnChangeTracker.ts";

type TrackerInput =
  | { readonly type: "turn-started"; readonly event: ProviderRuntimeTurnStartedEvent }
  | { readonly type: "turn-completed"; readonly event: ProviderRuntimeTurnCompletedEvent }
  | { readonly type: "turn-diff-updated"; readonly event: ProviderRuntimeTurnDiffUpdatedEvent };

const PRUNE_DEBOUNCE_MS = 30_000;

function toTurnState(state: string): VcsTurnScopeState {
  if (state === "failed") return "error";
  if (state === "cancelled" || state === "interrupted") return "interrupted";
  return "completed";
}

function makeWipMessage(threadTitle: string | undefined, turnId: TurnId): string {
  const label = threadTitle?.trim() || `turn ${turnId}`;
  return `wip: ${label.slice(0, 80)}`;
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const jjCore = yield* JjCore;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
  const turnChangeRepository = yield* VcsTurnChangeRepository;
  const externalDiffRepository = yield* VcsExternalDiffRepository;
  const lastPrunedAtByRoot = new Map<string, number>();

  const resolveThreadCwd = Effect.fn("JjTurnChangeTracker.resolveThreadCwd")(function* (
    threadId: ThreadId,
  ): Effect.fn.Return<
    Option.Option<{
      readonly cwd: string;
      readonly title: string;
    }>
  > {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    const sessions = yield* providerService.listSessions();
    const session = sessions.find((entry) => entry.threadId === threadId && entry.cwd);
    if (session?.cwd) {
      return Option.some({
        cwd: session.cwd,
        title: thread?.title ?? String(threadId),
      });
    }
    if (!thread) return Option.none();
    const cwd = resolveThreadWorkspaceCwd({
      thread,
      projects: readModel.projects,
    });
    return cwd
      ? Option.some({
          cwd,
          title: thread.title,
        })
      : Option.none();
  });

  const pruneEmptyChanges = Effect.fn("JjTurnChangeTracker.pruneEmptyChanges")(function* (
    cwd: string,
    repoRoot: string,
    force = false,
  ) {
    const now = Date.now();
    const lastPrunedAt = lastPrunedAtByRoot.get(repoRoot) ?? 0;
    if (!force && now - lastPrunedAt < PRUNE_DEBOUNCE_MS) return;
    lastPrunedAtByRoot.set(repoRoot, now);
    const prunedChangeIds = yield* jjCore.pruneEmptyUndescribedChanges(cwd);
    if (prunedChangeIds.length === 0) return;
    yield* turnChangeRepository.markPruned({
      repoRoot,
      changeIds: prunedChangeIds,
      prunedAt: new Date(now).toISOString(),
    });
  });

  const upsertLink = Effect.fn("JjTurnChangeTracker.upsertLink")(function* (input: {
    readonly repoRoot: string;
    readonly cwd: string;
    readonly changeId: string;
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly role: "guard" | "created" | "modified" | "fallback" | "finalized";
    readonly firstOperationId: string | null;
    readonly lastOperationId: string | null;
    readonly createdAt: string;
  }) {
    const change = yield* jjCore.readChange(input.cwd, input.changeId);
    yield* turnChangeRepository.upsertLink({
      repoRoot: input.repoRoot,
      changeId: change.changeId,
      threadId: input.threadId,
      turnId: input.turnId,
      role: input.role,
      firstOperationId: input.firstOperationId,
      lastOperationId: input.lastOperationId,
      firstCommitId: change.commitId,
      latestCommitId: change.commitId,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      prunedAt: null,
    });
  });

  const startTurnScope = Effect.fn("JjTurnChangeTracker.startTurnScope")(function* (
    event: ProviderRuntimeTurnStartedEvent,
  ) {
    if (!event.turnId) return;
    const resolved = yield* resolveThreadCwd(event.threadId);
    if (Option.isNone(resolved)) return;
    const { cwd, title } = resolved.value;
    const isJj = yield* jjCore.isJjRepository(cwd).pipe(Effect.catch(() => Effect.succeed(false)));
    if (!isJj) return;

    const repoRoot = yield* jjCore.root(cwd);
    yield* pruneEmptyChanges(cwd, repoRoot);
    const [operationId, currentChange] = yield* Effect.all([
      jjCore.readCurrentOperationId(cwd),
      jjCore.readChange(cwd, "@"),
    ]);

    yield* turnChangeRepository.upsertScope({
      repoRoot,
      cwd,
      vcs: "jj",
      threadId: event.threadId,
      turnId: event.turnId,
      state: "running",
      startOperationId: operationId,
      endOperationId: null,
      boundaryChangeId: currentChange.changeId,
      fallbackChangeId: null,
      startedAt: event.createdAt,
      completedAt: null,
      lastReconciledAt: event.createdAt,
    });

    if (!currentChange.empty || currentChange.description.trim().length > 0) {
      const fallback = yield* jjCore.ensureFallbackTurnChange(
        cwd,
        makeWipMessage(title, event.turnId),
      );
      yield* upsertLink({
        repoRoot,
        cwd,
        changeId: fallback.changeId,
        threadId: event.threadId,
        turnId: event.turnId,
        role: "guard",
        firstOperationId: operationId,
        lastOperationId: yield* jjCore.readCurrentOperationId(cwd),
        createdAt: event.createdAt,
      });
    }
  });

  const reconcileTurnScope = Effect.fn("JjTurnChangeTracker.reconcileTurnScope")(function* (
    event: ProviderRuntimeTurnCompletedEvent,
  ) {
    if (!event.turnId) return;
    const resolved = yield* resolveThreadCwd(event.threadId);
    if (Option.isNone(resolved)) return;
    const { cwd, title } = resolved.value;
    const isJj = yield* jjCore.isJjRepository(cwd).pipe(Effect.catch(() => Effect.succeed(false)));
    if (!isJj) return;

    const repoRoot = yield* jjCore.root(cwd);
    const now = event.createdAt;
    const currentOperationId = yield* jjCore.readCurrentOperationId(cwd);
    const scope = yield* turnChangeRepository.getScope({
      repoRoot,
      threadId: event.threadId,
      turnId: event.turnId,
    });
    const startOperationId = scope?.startOperationId ?? currentOperationId;

    let linkedChangeIds = new Set<string>();
    const touchedChangeIds =
      startOperationId.length > 0
        ? yield* jjCore
            .listOperationTouchedChanges(cwd, startOperationId, currentOperationId)
            .pipe(Effect.catch(() => Effect.succeed([])))
        : [];
    for (const changeId of touchedChangeIds) {
      yield* upsertLink({
        repoRoot,
        cwd,
        changeId,
        threadId: event.threadId,
        turnId: event.turnId,
        role: "modified",
        firstOperationId: startOperationId,
        lastOperationId: currentOperationId,
        createdAt: now,
      });
      linkedChangeIds = new Set([...linkedChangeIds, changeId]);
    }

    const existingLinks = yield* turnChangeRepository.listLinksByThread({
      threadId: event.threadId,
      turnId: event.turnId,
    });
    for (const link of existingLinks) {
      if (link.repoRoot === repoRoot && link.prunedAt === null) {
        linkedChangeIds.add(link.changeId);
      }
    }

    let fallbackChangeId = scope?.fallbackChangeId ?? null;
    if (linkedChangeIds.size === 0) {
      const boundaryRev = scope?.boundaryChangeId ?? "@";
      const boundary = yield* jjCore
        .readChange(cwd, boundaryRev)
        .pipe(Effect.catch(() => jjCore.readChange(cwd, "@")));
      if (!boundary.empty || boundary.description.trim().length > 0) {
        yield* jjCore.describeChangeIfEmpty(
          cwd,
          boundary.changeId,
          makeWipMessage(title, event.turnId),
        );
        yield* upsertLink({
          repoRoot,
          cwd,
          changeId: boundary.changeId,
          threadId: event.threadId,
          turnId: event.turnId,
          role: "fallback",
          firstOperationId: startOperationId,
          lastOperationId: currentOperationId,
          createdAt: now,
        });
        fallbackChangeId = boundary.changeId;
      }
    }

    yield* turnChangeRepository.completeScope({
      repoRoot,
      threadId: event.threadId,
      turnId: event.turnId,
      state: toTurnState(event.payload.state),
      endOperationId: currentOperationId,
      fallbackChangeId,
      completedAt: now,
    });
    yield* pruneEmptyChanges(cwd, repoRoot, true);
    yield* vcsStatusBroadcaster.refreshStatus(cwd);
  });

  const persistExternalDiff = Effect.fn("JjTurnChangeTracker.persistExternalDiff")(function* (
    event: ProviderRuntimeTurnDiffUpdatedEvent,
  ) {
    if (!event.turnId || event.payload.unifiedDiff.trim().length === 0) return;
    const resolved = yield* resolveThreadCwd(event.threadId);
    const cwd = Option.isSome(resolved) ? resolved.value.cwd : process.cwd();
    const isJj = yield* jjCore.isJjRepository(cwd).pipe(Effect.catch(() => Effect.succeed(false)));
    if (isJj) return;
    const files = parseTurnDiffFilesFromUnifiedDiff(event.payload.unifiedDiff).map((file) => ({
      path: file.path,
      insertions: file.additions,
      deletions: file.deletions,
    }));
    yield* externalDiffRepository.upsert({
      threadId: event.threadId,
      turnId: event.turnId,
      cwd,
      scope: Option.isSome(resolved) ? "non_repo" : "unsupported",
      files,
      diff: event.payload.unifiedDiff,
      createdAt: event.createdAt,
      updatedAt: event.createdAt,
    });
  });

  const processInput = (input: TrackerInput) => {
    switch (input.type) {
      case "turn-started":
        return startTurnScope(input.event);
      case "turn-completed":
        return reconcileTurnScope(input.event);
      case "turn-diff-updated":
        return persistExternalDiff(input.event);
    }
  };

  const processInputSafely = (input: TrackerInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("JJ turn/change tracker failed to process event", {
          eventType: input.event.type,
          threadId: input.event.threadId,
          turnId: input.event.turnId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processInputSafely);

  const start: JjTurnChangeTrackerShape["start"] = () =>
    Effect.forkScoped(
      Stream.runForEach(providerService.streamEvents, (event: ProviderRuntimeEvent) => {
        if (event.type === "turn.started") {
          return worker.enqueue({ type: "turn-started", event });
        }
        if (event.type === "turn.completed") {
          return worker.enqueue({ type: "turn-completed", event });
        }
        if (event.type === "turn.diff.updated") {
          return worker.enqueue({ type: "turn-diff-updated", event });
        }
        return Effect.void;
      }),
    ).pipe(Effect.asVoid);

  return {
    start,
    drain: worker.drain,
  } satisfies JjTurnChangeTrackerShape;
});

export const JjTurnChangeTrackerLive = Layer.effect(JjTurnChangeTracker, make);
