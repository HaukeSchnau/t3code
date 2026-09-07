import { assert, expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  OrchestrationDispatchCommandError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type LegacyOutboxCommand,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ThreadCoordinationBackend } from "../../mcp/toolkits/thread-orchestration/V2Bridge.ts";
import type { CommandPreprocessingProgress } from "../Services/CommandPreprocessingCoordinator.ts";
import { commandEnvelopeFingerprint } from "../CommandEnvelope.ts";
import type { PreparedLegacyOutboxCommand } from "./OrchestrationCommandDispatchWorkflow.ts";
import { makeOrchestrationCommandDispatchWorkflow } from "./OrchestrationCommandDispatchWorkflow.ts";

type LegacyTurnStartCommand = Extract<LegacyOutboxCommand, { readonly type: "thread.turn.start" }>;

const timestamp = "2026-01-01T00:00:00.000Z";
const threadId = ThreadId.make("legacy-replay-thread");
const projectId = ProjectId.make("legacy-replay-project");

function legacyCommand(overrides: Partial<LegacyTurnStartCommand> = {}): LegacyTurnStartCommand {
  return {
    type: "thread.turn.start",
    commandId: CommandId.make("legacy-replay-command"),
    threadId,
    message: {
      messageId: MessageId.make("legacy-replay-message"),
      role: "user",
      text: "continue the task",
      attachments: [],
    },
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    bootstrap: {
      createThread: {
        projectId,
        title: "Legacy replay",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/tmp/legacy-replay-worktree",
        createdAt: timestamp,
      },
      runSetupScript: true,
    },
    createdAt: timestamp,
    ...overrides,
  } as LegacyTurnStartCommand;
}

function progressFor(command: LegacyOutboxCommand): CommandPreprocessingProgress {
  return {
    commandId: command.commandId,
    aggregateKind: "thread",
    aggregateId: command.threadId,
    commandVariant: command.type,
    envelopeFingerprint: commandEnvelopeFingerprint(command),
    deferredPreprocessingCompleted: false,
    threadCreated: false,
    workspacePrepared: false,
    setup: { status: "pending" },
  };
}

function makeHarness(options: {
  readonly setupFailureOnFirstCompletion?: boolean;
  readonly command?: LegacyOutboxCommand;
}) {
  const command = options.command ?? legacyCommand();
  const progress = new Map<string, CommandPreprocessingProgress>();
  const receipts = new Map<string, { readonly sequence: number; readonly fingerprint: string }>();
  const rejected = new Set<string>();
  const dispatches: Array<OrchestrationCommand> = [];
  const receiptProofs: Array<LegacyOutboxCommand | OrchestrationCommand> = [];
  const preprocessingOrder: string[] = [];
  let nextSequence = 1;
  let setupCompletionAttempts = 0;
  let setupRuns = 0;

  const coordinator = {
    withCommandLock: <A, E, R>(_commandId: CommandId, effect: Effect.Effect<A, E, R>) => effect,
    claim: (candidate: LegacyOutboxCommand | OrchestrationCommand) => {
      preprocessingOrder.push(`claim:${candidate.commandId}`);
      const current = progress.get(candidate.commandId);
      if (current) return Effect.succeed(current);
      const next = progressFor(candidate as LegacyOutboxCommand);
      progress.set(candidate.commandId, next);
      return Effect.succeed(next);
    },
    markCompleted: (
      candidate: LegacyOutboxCommand | OrchestrationCommand,
      step:
        | "deferred-preprocessing-completed"
        | "thread-created"
        | "workspace-prepared"
        | "setup-completed",
    ) => {
      if (step === "setup-completed") {
        setupCompletionAttempts += 1;
        if (options.setupFailureOnFirstCompletion && setupCompletionAttempts === 1) {
          return Effect.fail(new OrchestrationDispatchCommandError({ message: "simulated crash" }));
        }
      }
      const current =
        progress.get(candidate.commandId) ?? progressFor(candidate as LegacyOutboxCommand);
      const next = {
        ...current,
        ...(step === "deferred-preprocessing-completed"
          ? { deferredPreprocessingCompleted: true }
          : {}),
        ...(step === "thread-created" ? { threadCreated: true } : {}),
        ...(step === "workspace-prepared" ? { workspacePrepared: true } : {}),
        ...(step === "setup-completed"
          ? {
              setup: {
                status: "completed" as const,
                execution: current.setup.status === "pending" ? null : current.setup.execution,
              },
            }
          : {}),
      };
      progress.set(candidate.commandId, next);
      return Effect.succeed(next);
    },
    claimSetup: (
      candidate: LegacyOutboxCommand | OrchestrationCommand,
      execution: { readonly executionKey: string; readonly scriptDigest: string },
    ) => {
      const current =
        progress.get(candidate.commandId) ?? progressFor(candidate as LegacyOutboxCommand);
      const existing = current.setup.status === "pending" ? undefined : current.setup.execution;
      if (
        existing &&
        (existing.executionKey !== execution.executionKey ||
          existing.scriptDigest !== execution.scriptDigest)
      ) {
        return Effect.fail(
          new OrchestrationDispatchCommandError({ message: "setup identity changed" }),
        );
      }
      const next = {
        ...current,
        setup: { status: "claimed" as const, execution: existing ?? execution },
      };
      progress.set(candidate.commandId, next);
      return Effect.succeed(next);
    },
  };

  const backend = {
    snapshotQuery: {
      getThreadShellById: () => Effect.succeed(Option.none()),
    },
    engine: {
      resolveReceipt: (candidate: LegacyOutboxCommand | OrchestrationCommand) => {
        receiptProofs.push(candidate);
        const receipt = receipts.get(candidate.commandId);
        if (receipt && receipt.fingerprint !== commandEnvelopeFingerprint(candidate)) {
          return Effect.fail(
            new OrchestrationDispatchCommandError({ message: "receipt mismatch" }),
          );
        }
        if (rejected.has(candidate.commandId)) {
          return Effect.fail(
            new OrchestrationDispatchCommandError({ message: "previously rejected" }),
          );
        }
        return Effect.succeed(
          receipt ? Option.some({ sequence: receipt.sequence, storedEvents: [] }) : Option.none(),
        );
      },
      dispatch: (candidate: OrchestrationCommand) => {
        dispatches.push(candidate);
        return Effect.succeed({ sequence: nextSequence++, storedEvents: [] });
      },
      dispatchWithinCommandLock: (
        prepared: OrchestrationCommand,
        original: LegacyOutboxCommand | OrchestrationCommand = prepared,
      ) => {
        dispatches.push(prepared);
        receipts.set(original.commandId, {
          sequence: nextSequence,
          fingerprint: commandEnvelopeFingerprint(original),
        });
        return Effect.succeed({ sequence: nextSequence++, storedEvents: [] });
      },
    },
  } as unknown as ThreadCoordinationBackend["Service"];

  let setupExecution = { executionKey: "setup-execution-a", scriptDigest: "setup-digest-a" };
  const initiallyResolvedSetupExecution = setupExecution;
  const setupRunner = {
    resolveForThread: () =>
      Effect.succeed({ status: "resolved" as const, execution: setupExecution }),
    runForThread: (input: {
      readonly reconcileClaimedLaunch: boolean;
      readonly expectedExecution: typeof setupExecution;
    }) => {
      setupRuns += 1;
      expect(input.expectedExecution).toEqual(initiallyResolvedSetupExecution);
      return Effect.succeed({
        status: "started" as const,
        scriptId: "setup-script",
        scriptName: "Setup",
        terminalId: "setup-terminal",
      });
    },
  };
  const workflow = makeOrchestrationCommandDispatchWorkflow({
    backend,
    commandPreprocessing: coordinator as never,
    textGeneration: {} as never,
    serverSettings: {} as never,
    threadWorkspaceService: {
      prepareWorkspace: () => Effect.die("unexpected workspace preparation"),
    } as never,
    projectSetupScriptRunner: setupRunner as never,
    vcsStatusBroadcaster: { refreshStatus: () => Effect.void } as never,
    prepareLegacyOutboxCommand: (original) => {
      preprocessingOrder.push(`prepare:${original.commandId}`);
      const prepared = { ...original } as unknown as OrchestrationCommand;
      return Effect.succeed({
        command: prepared,
        performDeferredPreprocessing: Effect.sync(() => preprocessingOrder.push("deferred")),
      } satisfies PreparedLegacyOutboxCommand);
    },
  });

  return {
    command,
    workflow,
    progress,
    receipts,
    rejected,
    dispatches,
    receiptProofs,
    preprocessingOrder,
    setSetupExecution: (next: typeof setupExecution) => {
      setupExecution = next;
    },
    get setupRuns() {
      return setupRuns;
    },
  };
}

it.effect("replays a legacy bootstrap with the exact original envelope and durable setup ids", () =>
  Effect.gen(function* () {
    const harness = makeHarness({});
    const result = yield* harness.workflow.replayLegacyOutbox(harness.command);

    expect(result.sequence).toBeGreaterThan(0);
    expect(harness.preprocessingOrder).toEqual([
      `prepare:${harness.command.commandId}`,
      `claim:${harness.command.commandId}`,
      "deferred",
    ]);
    expect(harness.receiptProofs[0]).toBe(harness.command);
    const finalDispatch = harness.dispatches.at(-1);
    expect(finalDispatch?.commandId).toBe(harness.command.commandId);
    expect(harness.progress.get(harness.command.commandId)?.setup).toEqual({
      status: "completed",
      execution: { executionKey: "setup-execution-a", scriptDigest: "setup-digest-a" },
    });
  }),
);

it.effect("replays an accepted legacy envelope without setup or deferred materialization", () =>
  Effect.gen(function* () {
    const harness = makeHarness({});
    yield* harness.workflow.replayLegacyOutbox(harness.command);
    const dispatchCount = harness.dispatches.length;
    const setupRuns = harness.setupRuns;
    harness.preprocessingOrder.length = 0;

    yield* harness.workflow.replayLegacyOutbox(harness.command);

    expect(harness.dispatches).toHaveLength(dispatchCount);
    expect(harness.setupRuns).toBe(setupRuns);
    expect(harness.preprocessingOrder).not.toContain("deferred");
  }),
);

it.effect("fails closed for a changed envelope and a previously rejected command", () =>
  Effect.gen(function* () {
    const changed = makeHarness({});
    yield* changed.workflow.replayLegacyOutbox(changed.command);
    const changedResult = yield* changed.workflow
      .replayLegacyOutbox({
        ...changed.command,
        message: { ...changed.command.message, text: "tampered" },
      } as LegacyTurnStartCommand)
      .pipe(Effect.result);
    assert.equal(changedResult._tag, "Failure");
    expect(changed.preprocessingOrder).toEqual([
      `prepare:${changed.command.commandId}`,
      `claim:${changed.command.commandId}`,
      "deferred",
      `prepare:${changed.command.commandId}`,
    ]);

    const rejected = makeHarness({});
    rejected.rejected.add(rejected.command.commandId);
    const rejectedResult = yield* rejected.workflow
      .replayLegacyOutbox(rejected.command)
      .pipe(Effect.result);
    assert.equal(rejectedResult._tag, "Failure");
    expect(rejected.preprocessingOrder).not.toContain("deferred");
  }),
);

it.effect("reuses a setup execution identity after a crash before setup completion", () =>
  Effect.gen(function* () {
    const harness = makeHarness({ setupFailureOnFirstCompletion: true });
    const first = yield* harness.workflow.replayLegacyOutbox(harness.command).pipe(Effect.result);
    assert.equal(first._tag, "Failure");
    expect(harness.progress.get(harness.command.commandId)?.setup).toEqual({
      status: "claimed",
      execution: { executionKey: "setup-execution-a", scriptDigest: "setup-digest-a" },
    });

    harness.setSetupExecution({
      executionKey: "setup-execution-b",
      scriptDigest: "setup-digest-b",
    });
    yield* harness.workflow.replayLegacyOutbox(harness.command);

    expect(harness.setupRuns).toBe(2);
    expect(harness.progress.get(harness.command.commandId)?.setup.status).toBe("completed");
  }),
);
