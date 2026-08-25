import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ProjectId,
  ThreadId,
  TurnId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderSession,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProjectionRestartSafetyState } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationListenerCallbackError } from "../../orchestration/Errors.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import { ProviderValidationError } from "../Errors.ts";
import { ProviderSessionReaper } from "../Services/ProviderSessionReaper.ts";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import { makeProviderSessionReaperLive } from "./ProviderSessionReaper.ts";

const defaultModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
} as const;

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async (): Promise<void> => {
    if (await predicate()) {
      return;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error("Timed out waiting for expectation.");
    }
    await Effect.runPromise(Effect.yieldNow);
    return poll();
  };

  return poll();
}

const drainFibers = Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow, {
  discard: true,
});

const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;

function makeReadModel(
  threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly session: {
      readonly threadId: ThreadId;
      readonly status: "starting" | "running" | "ready" | "interrupted" | "stopped" | "error";
      readonly providerName: "codex" | "claudeAgent";
      readonly runtimeMode: "approval-required" | "full-access" | "auto-accept-edits";
      readonly activeTurnId: TurnId | null;
      readonly lastError: string | null;
      readonly updatedAt: string;
    } | null;
    readonly backgroundLiveness?: "working" | "monitoring" | null;
  }>,
) {
  const now = "2026-01-01T00:00:00.000Z";
  const projectId = ProjectId.make("project-provider-session-reaper");

  return {
    snapshotSequence: 0,
    updatedAt: now,
    projects: [
      {
        id: projectId,
        title: "Provider Reaper Project",
        workspaceRoot: "/tmp/provider-reaper-project",
        defaultModelSelection,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
    threads: threads.map((thread) => ({
      id: thread.id,
      projectId,
      title: `Thread ${thread.id}`,
      modelSelection: defaultModelSelection,
      interactionMode: "default" as const,
      runtimeMode: "full-access" as const,
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
      latestTurn: null,
      messages: [],
      session: thread.session,
      backgroundLiveness: thread.backgroundLiveness ?? null,
      activities: [],
      proposedPlans: [],
      checkpoints: [],
      deletedAt: null,
    })),
  };
}

describe("ProviderSessionReaper", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    ProviderSessionReaper | ProviderSessionRuntime.ProviderSessionRuntimeRepository,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
  });

  // Shared start sequence so each test adds no manual Effect runners
  // (no-manual-effect-runtime-in-tests tracks this file's legacy count).
  async function startReaper() {
    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));
  }

  async function createHarness(input: {
    readonly readModel: ReturnType<typeof makeReadModel>;
    readonly runtimeStartedAt?: string;
    readonly sweepIntervalMs?: number;
    readonly liveSessions?: ReadonlyArray<ProviderSession>;
    readonly restartSafetyStateImplementation?: () => Effect.Effect<ProjectionRestartSafetyState>;
    readonly dispatchImplementation?: (
      command: unknown,
    ) => Effect.Effect<{ sequence: number }, ProviderValidationError>;
    readonly stopSessionImplementation?: (input: {
      readonly threadId: ThreadId;
    }) => ReturnType<ProviderServiceShape["stopSession"]>;
  }) {
    const stoppedThreadIds = new Set<ThreadId>();
    const stopSession = vi.fn<ProviderServiceShape["stopSession"]>(
      (request) =>
        (input.stopSessionImplementation
          ? input.stopSessionImplementation(request)
          : Effect.sync(() => {
              stoppedThreadIds.add(request.threadId);
            })) as ReturnType<ProviderServiceShape["stopSession"]>,
    );

    const providerService: ProviderServiceShape = {
      startSession: () => unsupported(),
      sendTurn: () => unsupported(),
      interruptTurn: () => unsupported(),
      respondToRequest: () => unsupported(),
      respondToUserInput: () => unsupported(),
      stopSession,
      listSessions: () => Effect.succeed(input.liveSessions ?? []),
      getCapabilities: () =>
        Effect.succeed({
          sessionModelSwitch: "in-session",
          assistantTranscriptRecovery: "none",
        }),
      getInstanceInfo: (instanceId) => {
        const driverKind = ProviderDriverKind.make(String(instanceId));
        return Effect.succeed({
          instanceId,
          driverKind,
          displayName: undefined,
          enabled: true,
          continuationIdentity: {
            driverKind,
            continuationKey: `${driverKind}:instance:${instanceId}`,
          },
        });
      },
      rollbackConversation: () => unsupported(),
      uploadFeedback: () => unsupported(),
      streamEvents: Stream.empty,
    };
    const dispatch = vi.fn((command: unknown) =>
      input.dispatchImplementation === undefined
        ? Effect.succeed({ sequence: 1 })
        : input.dispatchImplementation(command),
    );

    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const providerSessionDirectoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(runtimeRepositoryLayer),
    );
    const layer = makeProviderSessionReaperLive({
      inactivityThresholdMs: 1_000,
      sweepIntervalMs: input.sweepIntervalMs ?? 60_000,
      runtimeStartedAt: input.runtimeStartedAt ?? "2025-01-01T00:00:00.000Z",
    }).pipe(
      Layer.provideMerge(providerSessionDirectoryLayer),
      Layer.provideMerge(runtimeRepositoryLayer),
      Layer.provideMerge(Layer.succeed(ProviderService, providerService)),
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery, {
          getCommandReadModel: () => Effect.die("unused"),
          getSnapshot: () => Effect.die("unused"),
          getShellSnapshot: () => Effect.die("unused"),
          getArchivedShellSnapshot: () => Effect.die("unused"),
          getSnapshotSequence: () =>
            Effect.succeed({ snapshotSequence: input.readModel.snapshotSequence }),
          getCounts: () => Effect.die("unused"),
          getRestartSafetyState: () =>
            input.restartSafetyStateImplementation?.() ??
            Effect.succeed({
              threads: input.readModel.threads.map((thread) => ({
                threadId: thread.id,
                session: thread.session,
                latestTurnId: null,
                latestTurnState: null,
                latestTurnUpdatedAt: null,
                queuedMessageCount: 0,
                pendingApprovalCount: thread.hasPendingApprovals ? 1 : 0,
                pendingUserInputCount: thread.hasPendingUserInput ? 1 : 0,
                undeliveredTranscriptEventCount: 0,
              })),
            }),
          getActiveProjectByWorkspaceRoot: () => Effect.die("unused"),
          getProjectShellById: () => Effect.die("unused"),
          getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
          getThreadCheckpointContext: () => Effect.die("unused"),
          getFullThreadDiffContext: () => Effect.die("unused"),
          getThreadShellById: (threadId) =>
            Effect.succeed(
              input.readModel.threads.find((thread) => thread.id === threadId)
                ? Option.some(input.readModel.threads.find((thread) => thread.id === threadId)!)
                : Option.none(),
            ),
          getThreadResultContextById: () => Effect.die("unused"),
          getThreadDetailById: () => Effect.die("unused"),
          getThreadDetailSnapshot: () => Effect.die("unused"),
          getTurnActivitiesSnapshot: () => Effect.die("unused"),
          searchThreads: () => Effect.succeed({ matches: [] }),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(OrchestrationEngineService)({
          dispatch: (command) =>
            dispatch(command).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationListenerCallbackError({
                    listener: "read-model",
                    detail: cause.message,
                    cause,
                  }),
              ),
            ),
        }),
      ),
      Layer.provideMerge(NodeServices.layer),
    );

    runtime = ManagedRuntime.make(layer);
    return { stopSession, stoppedThreadIds, dispatch };
  }

  it("reaps stale persisted sessions without active turns", async () => {
    const threadId = ThreadId.make("thread-reaper-stale");
    const now = "2026-01-01T00:00:00.000Z";
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: {
          opaque: "resume-stale",
        },
        runtimePayload: null,
      }),
    );

    await startReaper();

    await waitFor(() => harness.stopSession.mock.calls.length === 1);

    expect(harness.stopSession.mock.calls[0]?.[0]).toEqual({ threadId });
    expect(harness.stoppedThreadIds.has(threadId)).toBe(true);
  });

  it("skips stale sessions when the thread still has an active turn", async () => {
    const threadId = ThreadId.make("thread-reaper-active-turn");
    const turnId = TurnId.make("turn-reaper-active");
    const now = "2026-01-01T00:00:00.000Z";
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "running",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: {
          opaque: "resume-active-turn",
        },
        runtimePayload: null,
      }),
    );

    await startReaper();
    await Effect.runPromise(drainFibers);

    expect(harness.stopSession).not.toHaveBeenCalled();
    const remaining = await runtime!.runPromise(repository.getByThreadId({ threadId }));
    expect(Option.isSome(remaining)).toBe(true);
  });

  it("skips stale sessions while background work is still live", async () => {
    const threadId = ThreadId.make("thread-reaper-background-work");
    const now = "2026-01-01T00:00:00.000Z";
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
          backgroundLiveness: "working",
        },
      ]),
    });
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: {
          opaque: "resume-background-work",
        },
        runtimePayload: null,
      }),
    );

    await startReaper();
    await Effect.runPromise(drainFibers);

    expect(harness.stopSession).not.toHaveBeenCalled();
    const remaining = await runtime!.runPromise(repository.getByThreadId({ threadId }));
    expect(Option.isSome(remaining)).toBe(true);
  });

  it("does not reap sessions that are still within the inactivity threshold", async () => {
    const threadId = ThreadId.make("thread-reaper-fresh");
    const now = DateTime.formatIso(await Effect.runPromise(DateTime.now));
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: now,
        resumeCursor: {
          opaque: "resume-fresh",
        },
        runtimePayload: null,
      }),
    );

    await startReaper();
    await Effect.runPromise(drainFibers);

    expect(harness.stopSession).not.toHaveBeenCalled();
    const remaining = await runtime!.runPromise(repository.getByThreadId({ threadId }));
    expect(Option.isSome(remaining)).toBe(true);
  });

  it("skips persisted sessions that are already marked stopped", async () => {
    const threadId = ThreadId.make("thread-reaper-stopped");
    const now = "2026-01-01T00:00:00.000Z";
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "stopped",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "stopped",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: {
          opaque: "resume-stopped",
        },
        runtimePayload: null,
      }),
    );

    await startReaper();
    await Effect.runPromise(drainFibers);

    expect(harness.stopSession).not.toHaveBeenCalled();
    const remaining = await runtime!.runPromise(repository.getByThreadId({ threadId }));
    expect(Option.isSome(remaining)).toBe(true);
  });

  it("continues reaping other sessions when one stop attempt fails", async () => {
    const failedThreadId = ThreadId.make("thread-reaper-stop-failure");
    const reapedThreadId = ThreadId.make("thread-reaper-stop-success");
    const now = "2026-01-01T00:00:00.000Z";
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: failedThreadId,
          session: {
            threadId: failedThreadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
        {
          id: reapedThreadId,
          session: {
            threadId: reapedThreadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
      stopSessionImplementation: (request) =>
        request.threadId === failedThreadId
          ? Effect.fail(
              new ProviderValidationError({
                operation: "ProviderSessionReaper.test",
                issue: "simulated stop failure",
              }),
            )
          : Effect.void,
    });
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );

    await runtime!.runPromise(
      repository.upsert({
        threadId: failedThreadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: {
          opaque: "resume-failure",
        },
        runtimePayload: null,
      }),
    );
    await runtime!.runPromise(
      repository.upsert({
        threadId: reapedThreadId,
        providerName: "codex",
        providerInstanceId: null,
        adapterKey: "codex",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:01:00.000Z",
        resumeCursor: {
          opaque: "resume-success",
        },
        runtimePayload: null,
      }),
    );

    await startReaper();

    await waitFor(() => harness.stopSession.mock.calls.length === 2);

    expect(harness.stopSession.mock.calls.map(([request]) => request.threadId)).toEqual([
      failedThreadId,
      reapedThreadId,
    ]);
  });

  it("continues reaping other sessions when one stop attempt defects", async () => {
    const defectThreadId = ThreadId.make("thread-reaper-stop-defect");
    const reapedThreadId = ThreadId.make("thread-reaper-stop-after-defect");
    const now = "2026-01-01T00:00:00.000Z";
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: defectThreadId,
          session: {
            threadId: defectThreadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
        {
          id: reapedThreadId,
          session: {
            threadId: reapedThreadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
      stopSessionImplementation: (request) =>
        request.threadId === defectThreadId
          ? Effect.die(new Error("simulated stop defect"))
          : Effect.void,
    });
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );

    await runtime!.runPromise(
      repository.upsert({
        threadId: defectThreadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: {
          opaque: "resume-defect",
        },
        runtimePayload: null,
      }),
    );
    await runtime!.runPromise(
      repository.upsert({
        threadId: reapedThreadId,
        providerName: "codex",
        providerInstanceId: null,
        adapterKey: "codex",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:01:00.000Z",
        resumeCursor: {
          opaque: "resume-after-defect",
        },
        runtimePayload: null,
      }),
    );

    await startReaper();

    await waitFor(() => harness.stopSession.mock.calls.length === 2);

    expect(harness.stopSession.mock.calls.map(([request]) => request.threadId)).toEqual([
      defectThreadId,
      reapedThreadId,
    ]);
  });

  it("durably interrupts an orphaned turn from an older runtime without deleting resume state", async () => {
    const threadId = ThreadId.make("thread-reconcile-orphan");
    const turnId = TurnId.make("turn-reconcile-orphan");
    const projectedAt = "2026-07-15T14:28:38.073Z";
    const harness = await createHarness({
      runtimeStartedAt: "2026-07-16T08:29:00.000Z",
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: projectedAt,
          },
        },
      ]),
    });
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );
    const resumeCursor = { threadId: "provider-thread-1" };
    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        adapterKey: "codex",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: projectedAt,
        resumeCursor,
        runtimePayload: { cwd: "/tmp/project" },
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await runtime!.runPromise(Scope.make("sequential"));
    await runtime!.runPromise(reaper.start().pipe(Scope.provide(scope)));

    expect(harness.dispatch).toHaveBeenCalledTimes(1);
    expect(harness.dispatch.mock.calls[0]?.[0]).toMatchObject({
      type: "thread.session.set",
      threadId,
      session: {
        status: "interrupted",
        activeTurnId: null,
        providerName: "codex",
      },
    });
    const persisted = Option.getOrThrow(
      await runtime!.runPromise(repository.getByThreadId({ threadId })),
    );
    expect(persisted.resumeCursor).toEqual(resumeCursor);
    expect(persisted.runtimePayload).toEqual({ cwd: "/tmp/project" });
  });

  it("does not repair a running live session that omits activeTurnId", async () => {
    const threadId = ThreadId.make("thread-reconcile-live-running");
    const turnId = TurnId.make("turn-reconcile-live-running");
    const readModel = makeReadModel([
      {
        id: threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: turnId,
          lastError: null,
          updatedAt: "2026-07-15T14:28:38.073Z",
        },
      },
    ]);
    const harness = await createHarness({
      runtimeStartedAt: "2026-07-16T08:29:00.000Z",
      readModel,
      liveSessions: [
        {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          threadId,
          status: "running",
          runtimeMode: "full-access",
          createdAt: "2026-07-16T08:29:00.000Z",
          updatedAt: "2026-07-16T08:29:00.000Z",
        },
      ],
    });

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await runtime!.runPromise(Scope.make("sequential"));
    await runtime!.runPromise(reaper.start().pipe(Scope.provide(scope)));

    expect(harness.dispatch).not.toHaveBeenCalled();
  });

  it("retries reconciliation after the transcript backlog drains", async () => {
    const threadId = ThreadId.make("thread-reconcile-backlog");
    const turnId = TurnId.make("turn-reconcile-backlog");
    const readModel = makeReadModel([
      {
        id: threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: turnId,
          lastError: null,
          updatedAt: "2026-07-15T14:28:38.073Z",
        },
      },
    ]);
    let restartStateReads = 0;
    const harness = await createHarness({
      runtimeStartedAt: "2026-07-16T08:29:00.000Z",
      sweepIntervalMs: 10,
      readModel,
      restartSafetyStateImplementation: () => {
        restartStateReads += 1;
        return Effect.succeed({
          threads: [
            {
              threadId,
              session: readModel.threads[0]!.session,
              latestTurnId: turnId,
              latestTurnState: "running",
              latestTurnUpdatedAt: "2026-07-15T14:28:38.073Z",
              queuedMessageCount: 0,
              pendingApprovalCount: 0,
              pendingUserInputCount: 0,
              undeliveredTranscriptEventCount: restartStateReads === 1 ? 1 : 0,
            },
          ],
        });
      },
    });

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await runtime!.runPromise(Scope.make("sequential"));
    await runtime!.runPromise(reaper.start().pipe(Scope.provide(scope)));

    expect(harness.dispatch).not.toHaveBeenCalled();
    await waitFor(() => harness.dispatch.mock.calls.length === 1);
    expect(restartStateReads).toBeGreaterThanOrEqual(2);
  });

  it("uses one deterministic command envelope when retrying a lost acknowledgement", async () => {
    const threadId = ThreadId.make("thread-reconcile-lost-ack");
    const turnId = TurnId.make("turn-reconcile-lost-ack");
    const readModel = makeReadModel([
      {
        id: threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: turnId,
          lastError: null,
          updatedAt: "2026-07-15T14:28:38.073Z",
        },
      },
    ]);
    let attempts = 0;
    const harness = await createHarness({
      runtimeStartedAt: "2026-07-16T08:29:00.000Z",
      sweepIntervalMs: 10,
      readModel,
      dispatchImplementation: () => {
        attempts += 1;
        return attempts === 1
          ? Effect.fail(
              new ProviderValidationError({
                operation: "ProviderSessionReaper.test",
                issue: "durable write succeeded but acknowledgement was lost",
              }),
            )
          : Effect.succeed({ sequence: 1 });
      },
    });

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await runtime!.runPromise(Scope.make("sequential"));
    await runtime!.runPromise(reaper.start().pipe(Scope.provide(scope)));
    await waitFor(() => harness.dispatch.mock.calls.length >= 2);

    expect(harness.dispatch.mock.calls[0]?.[0]).toEqual(harness.dispatch.mock.calls[1]?.[0]);
    expect(harness.dispatch.mock.calls[0]?.[0]).toMatchObject({
      type: "thread.session.set",
      commandId: CommandId.make(
        `provider:startup-reconcile:2026-07-16T08:29:00.000Z:${threadId}:${turnId}:set-session-interrupted`,
      ),
      createdAt: "2026-07-16T08:29:00.000Z",
      session: { updatedAt: "2026-07-16T08:29:00.000Z" },
    });
  });

  it("settles a legacy running turn without creating a provider session", async () => {
    const threadId = ThreadId.make("thread-reconcile-legacy-turn");
    const turnId = TurnId.make("turn-reconcile-legacy-turn");
    const readModel = makeReadModel([{ id: threadId, session: null }]);
    const harness = await createHarness({
      runtimeStartedAt: "2026-07-16T08:29:00.000Z",
      readModel,
      restartSafetyStateImplementation: () =>
        Effect.succeed({
          threads: [
            {
              threadId,
              session: null,
              latestTurnId: turnId,
              latestTurnState: "running",
              latestTurnUpdatedAt: "2026-07-15T14:28:38.073Z",
              queuedMessageCount: 0,
              pendingApprovalCount: 0,
              pendingUserInputCount: 0,
              undeliveredTranscriptEventCount: 0,
            },
          ],
        }),
    });
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );
    const resumeCursor = { threadId: "legacy-provider-thread" };
    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        adapterKey: "codex",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-07-15T14:28:38.073Z",
        resumeCursor,
        runtimePayload: { cwd: "/tmp/legacy" },
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await runtime!.runPromise(Scope.make("sequential"));
    await runtime!.runPromise(reaper.start().pipe(Scope.provide(scope)));

    expect(harness.dispatch).toHaveBeenCalledTimes(1);
    expect(harness.dispatch.mock.calls[0]?.[0]).toEqual({
      type: "thread.turn.interrupt",
      commandId: CommandId.make(
        `provider:startup-reconcile:2026-07-16T08:29:00.000Z:${threadId}:${turnId}:interrupt-turn`,
      ),
      threadId,
      turnId,
      createdAt: "2026-07-16T08:29:00.000Z",
    });
    expect(readModel.threads[0]!.session).toBeNull();
    const persisted = Option.getOrThrow(
      await runtime!.runPromise(repository.getByThreadId({ threadId })),
    );
    expect(persisted.resumeCursor).toEqual(resumeCursor);
    expect(persisted.runtimePayload).toEqual({ cwd: "/tmp/legacy" });
  });
});
