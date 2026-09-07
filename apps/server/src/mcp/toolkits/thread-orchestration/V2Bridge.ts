import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import { CommandPreprocessingCoordinator } from "../../../orchestration/Services/CommandPreprocessingCoordinator.ts";
import { OrchestrationCommandReceiptRepository } from "../../../persistence/Services/OrchestrationCommandReceipts.ts";
import { commandEnvelopeFingerprint } from "../../../orchestration/CommandEnvelope.ts";
import {
  ThreadOrchestrationError,
  CommandId,
  EventId,
  OrchestrationMessage,
  OrchestrationThread,
  OrchestrationThreadShell,
  OrchestrationV2ConversationMessageJson,
  OrchestrationV2TurnItemJson,
  OrchestrationV2ThreadShellJson,
  RunId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type LegacyOutboxCommand,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ThreadShell,
  type ProjectId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { EventSinkV2 } from "../../../orchestration-v2/EventSink.ts";
import { ProjectionStoreV2 } from "../../../orchestration-v2/ProjectionStore.ts";
import { LegacyV1ThreadImporter } from "../../../orchestration-v2/LegacyV1ThreadImporter.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../../../project/ProjectService.ts";
import { readCoordinationActivities } from "../../../orchestration/CoordinationActivityQuery.ts";
import { deriveThreadCoordinationShell } from "../../../orchestration/ThreadCoordinationProjection.ts";

const decodeShell = Schema.decodeUnknownSync(OrchestrationThreadShell);
const encodeShell = Schema.encodeSync(OrchestrationV2ThreadShellJson);
const decodeMessage = Schema.decodeUnknownSync(OrchestrationMessage);
const decodeThread = Schema.decodeUnknownSync(OrchestrationThread);
const encodeTurnItem = Schema.encodeSync(OrchestrationV2TurnItemJson);

function legacyShell(thread: OrchestrationV2ThreadShell) {
  const json = encodeShell(thread);
  const state =
    thread.status === "failed"
      ? "error"
      : ["running", "starting", "waiting", "preparing"].includes(thread.status)
        ? "running"
        : thread.status === "cancelled" || thread.status === "rolled_back"
          ? "interrupted"
          : thread.status === "queued"
            ? "pending"
            : thread.status;
  return decodeShell({
    ...json,
    latestTurn:
      thread.latestRunId === null
        ? null
        : {
            turnId: thread.latestRunId,
            state: state === "idle" ? "completed" : state,
            requestedAt: json.latestRunRequestedAt ?? json.createdAt,
            startedAt: json.latestRunStartedAt ?? null,
            completedAt: json.latestRunCompletedAt ?? null,
            assistantMessageId: null,
          },
    session: {
      threadId: thread.id,
      providerName: thread.providerInstanceId,
      providerInstanceId: thread.providerInstanceId,
      runtimeMode: thread.runtimeMode,
      status:
        state === "running"
          ? "running"
          : state === "error"
            ? "error"
            : state === "interrupted"
              ? "interrupted"
              : "ready",
      activeTurnId: thread.activeRunId,
      lastError: thread.lastError || null,
      updatedAt: json.updatedAt,
    },
    hasPendingApprovals:
      thread.pendingRuntimeRequest !== null && thread.pendingRuntimeRequest.kind !== "user_input",
    hasPendingUserInput: thread.pendingRuntimeRequest?.kind === "user_input",
  });
}

function legacyMessage(message: OrchestrationV2ConversationMessage) {
  return decodeMessage({
    ...message,
    turnId: message.runId,
    createdAt: DateTime.formatIso(message.createdAt),
    updatedAt: DateTime.formatIso(message.updatedAt),
  });
}

/** Keeps the public CLI coordination contract while all thread execution uses V2. */
export const makeThreadCoordinationBridge = Effect.gen(function* () {
  const projections = yield* ProjectionStoreV2;
  const threads = yield* ThreadManagementService;
  const importer = yield* LegacyV1ThreadImporter;
  const projects = yield* ProjectService;
  const sink = yield* EventSinkV2;
  const sql = yield* SqlClient.SqlClient;
  const preprocessing = yield* CommandPreprocessingCoordinator;
  const receipts = yield* OrchestrationCommandReceiptRepository;
  const provenance = { createdBy: "agent" as const, creationSource: "mcp" as const };

  const activities = Effect.fn("ThreadCoordinationBridge.activities")(function* (
    threadId?: ThreadId,
  ) {
    const decoded = yield* readCoordinationActivities(sql, threadId);
    return Array.from(new Map(decoded.map((activity) => [activity.id, activity])).values()).sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  });

  const getThreadShellById = (id: ThreadId) =>
    projections
      .getThreadShell(id)
      .pipe(
        Effect.map((thread) =>
          thread === null ? Option.none() : Option.some(legacyShell(thread)),
        ),
      );
  const getProjectShellById = (id: ProjectId) => projects.getById(id);
  const getThreadDetailById = Effect.fn("ThreadCoordinationBridge.detail")(function* (
    id: ThreadId,
  ) {
    const shell = yield* getThreadShellById(id);
    if (Option.isNone(shell)) return Option.none();
    const projection = yield* threads.getThreadProjection(id);
    const messages = projection.messages
      .filter((message) => message.role !== "system")
      .map(legacyMessage);
    const coordination = yield* activities(id);
    return Option.some(
      decodeThread({
        ...shell.value,
        deletedAt:
          projection.thread.deletedAt === null
            ? null
            : DateTime.formatIso(projection.thread.deletedAt),
        messages,
        activities: [
          ...coordination,
          ...projection.turnItems.flatMap((item) => {
            if (
              item.type === "user_message" ||
              item.type === "assistant_message" ||
              (item.type === "system_notice" && item.coordinationActivity !== undefined)
            )
              return [];
            return [
              {
                id: EventId.make(item.id),
                tone: item.type === "error" ? "error" : "tool",
                kind: `v2.${item.type}`,
                summary: item.title || ("message" in item ? item.message : item.type),
                payload: encodeTurnItem(item),
                turnId: item.runId,
                createdAt: DateTime.formatIso(item.startedAt ?? item.updatedAt),
              },
            ];
          }),
        ].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
        checkpoints: [],
        proposedPlans: [],
        queuedMessages: projection.runs
          .filter((run) => run.status === "queued")
          .flatMap((run) => {
            const message = projection.messages.find(
              (candidate) => candidate.id === run.userMessageId,
            );
            return message
              ? [
                  {
                    messageId: message.id,
                    threadId: id,
                    text: message.text,
                    attachments: message.attachments,
                    origin: message.origin,
                    modelSelection: run.modelSelection,
                    runtimeMode: projection.thread.runtimeMode,
                    interactionMode: projection.thread.interactionMode,
                    createdAt: DateTime.formatIso(message.createdAt),
                    updatedAt: DateTime.formatIso(message.updatedAt),
                  },
                ]
              : [];
          }),
      }),
    );
  });
  const getThreadResultContextById = Effect.fn("ThreadCoordinationBridge.result")(function* (
    id: ThreadId,
  ) {
    const shell = yield* getThreadShellById(id);
    if (Option.isNone(shell)) return Option.none();
    const project = yield* projects.getById(shell.value.projectId);
    if (Option.isNone(project)) return Option.none();
    yield* importer.ensureTranscript(id);
    const latest = yield* sql<{ payload: string }>`
      SELECT payload_json AS payload FROM orchestration_v2_projection_messages
      WHERE thread_id = ${id} AND role IN ('user', 'assistant')
      ORDER BY created_at DESC, message_id DESC LIMIT 1
    `;
    const assistant = yield* sql<{ payload: string }>`
      SELECT payload_json AS payload FROM orchestration_v2_projection_messages
      WHERE thread_id = ${id} AND role = 'assistant'
      ORDER BY created_at DESC, message_id DESC LIMIT 1
    `;
    const counts = yield* sql<{ queued: number; activity: number }>`
      SELECT
        (SELECT COUNT(*) FROM orchestration_v2_projection_runs WHERE thread_id = ${id} AND status = 'queued') AS queued,
        (SELECT COUNT(*) FROM orchestration_v2_projection_turn_items WHERE thread_id = ${id}) AS activity
    `;
    const decode = Schema.decodeUnknownEffect(
      Schema.fromJsonString(OrchestrationV2ConversationMessageJson),
    );
    const latestMessage = latest[0] ? legacyMessage(yield* decode(latest[0].payload)) : null;
    const latestAssistantMessage = assistant[0]
      ? legacyMessage(yield* decode(assistant[0].payload))
      : null;
    return Option.some({
      thread: shell.value,
      project: project.value,
      latestMessage,
      latestAssistantMessage,
      queuedMessageCount: counts[0]?.queued ?? 0,
      activityCount: counts[0]?.activity ?? 0,
    });
  });
  const snapshotQuery = {
    getNativeThreadProjection: threads.getThreadProjection,
    getThreadShellById,
    getProjectShellById,
    getThreadDetailById,
    getThreadResultContextById,
    getThreadCoordinationShell: () => activities().pipe(Effect.map(deriveThreadCoordinationShell)),
    listThreadRelationshipActivities: () =>
      activities().pipe(
        Effect.map((rows) =>
          rows.filter((row) => row.kind === "thread-orchestration.relationship"),
        ),
      ),
    listThreadOrchestrationBatchActivities: () =>
      activities().pipe(
        Effect.map((rows) =>
          rows.filter((row) => row.kind.startsWith("thread-orchestration.batch.")),
        ),
      ),
    getShellSnapshot: () =>
      Effect.gen(function* () {
        const shell = yield* projections.getShellSnapshot();
        const projectSnapshot = yield* projects.snapshot;
        return {
          snapshotSequence: shell.snapshotSequence,
          threads: shell.threads.map(legacyShell),
          projects: projectSnapshot.projects,
          coordination: deriveThreadCoordinationShell(yield* activities()),
        };
      }),
  };

  const dispatchOnce = Effect.fn("ThreadCoordinationBridge.dispatchOnce")(function* (
    command: OrchestrationCommand,
  ) {
    switch (command.type) {
      case "thread.activity.append":
        return yield* threads.dispatch({
          type: "coordination.activity.append",
          commandId: command.commandId,
          threadId: command.threadId,
          activity: command.activity,
        });
      case "thread.create":
        return yield* threads.dispatch({
          type: "thread.create",
          ...provenance,
          commandId: command.commandId,
          threadId: command.threadId,
          projectId: command.projectId,
          title: command.title,
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          branch: command.branch,
          worktreePath: command.worktreePath,
          workspaceId: command.workspaceId,
          skillPackIds: command.skillPackIds,
          titleMode: command.titleMode,
          skillScope: command.skillScope,
        });
      case "thread.meta.update":
        return yield* threads.dispatch({
          type: "thread.metadata.update",
          commandId: command.commandId,
          threadId: command.threadId,
          title: command.title,
          titleMode: command.titleMode ?? (command.title === undefined ? undefined : "manual"),
          expectedTitle: command.expectedTitle,
          expectedBranch: command.expectedBranch,
          regenerateTitle: command.regenerateTitle,
          linkedPullRequest: command.linkedPullRequest,
          branch: command.branch,
          worktreePath: command.worktreePath,
          workspaceId: command.workspaceId,
        });
      case "thread.active.reorder":
        return yield* threads.dispatch({
          type: "thread.metadata.update",
          commandId: command.commandId,
          threadId: command.threadId,
          activeOrderKey: command.orderKey,
        });
      case "thread.turn.interrupt": {
        const projection = yield* threads.getThreadProjection(command.threadId);
        const active = projection.runs.find((run) =>
          ["preparing", "starting", "running", "waiting"].includes(run.status),
        );
        if (!active)
          return {
            sequence: (yield* projections.getShellSnapshot()).snapshotSequence,
            storedEvents: [],
          };
        return yield* threads.dispatch({
          type: "run.interrupt",
          commandId: command.commandId,
          threadId: command.threadId,
          runId: active.id,
        });
      }
      case "thread.turn.start":
      case "thread.message.queue": {
        return yield* threads.dispatch({
          type: "message.dispatch",
          ...provenance,
          commandId: command.commandId,
          threadId: command.threadId,
          messageId: command.message.messageId,
          text: command.message.text,
          attachments: command.message.attachments ?? [],
          origin: command.message.origin,
          modelSelection: command.modelSelection,
          titleSeed: command.titleSeed,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          dispatchMode: {
            type:
              command.type === "thread.message.queue" && command.delivery !== "immediate"
                ? "queue_after_active"
                : "steer_if_active",
          },
        });
      }
      default:
        return yield* Effect.fail(
          new ThreadOrchestrationError({
            operation: "dispatch",
            message: `Unsupported CLI coordination command: ${command.type}`,
          }),
        );
    }
  });
  const resolveReceipt = (command: OrchestrationCommand | LegacyOutboxCommand) =>
    Effect.gen(function* () {
      const receipt = yield* receipts.getByCommandId({ commandId: command.commandId });
      if (Option.isNone(receipt)) return Option.none();
      const previous = receipt.value;
      const threadId = "threadId" in command ? command.threadId : undefined;
      const fingerprint = commandEnvelopeFingerprint(command);
      const nativeType =
        command.type === "thread.activity.append"
          ? "coordination.activity.append"
          : command.type === "thread.meta.update"
            ? "thread.metadata.update"
            : command.type === "thread.active.reorder"
              ? "thread.metadata.update"
              : command.type === "thread.turn.interrupt"
                ? "run.interrupt"
                : command.type === "thread.turn.start" || command.type === "thread.message.queue"
                  ? "message.dispatch"
                  : command.type;
      const progress =
        previous.commandType === "legacy"
          ? []
          : yield* sql<{
              readonly envelope_fingerprint: string;
              readonly command_variant: string;
            }>`SELECT envelope_fingerprint, command_variant FROM orchestration_command_preprocessing
       WHERE command_id = ${command.commandId}`;
      const matches =
        previous.commandType === "legacy"
          ? previous.commandVariant === command.type && previous.envelopeFingerprint === fingerprint
          : previous.commandType === nativeType &&
            progress[0]?.command_variant === command.type &&
            progress[0]?.envelope_fingerprint === fingerprint;
      if (previous.aggregateKind !== "thread" || previous.aggregateId !== threadId || !matches) {
        return yield* new ThreadOrchestrationError({
          operation: "dispatch",
          code: "receipt_mismatch",
          message: "The command receipt cannot verify this exact legacy envelope.",
        });
      }
      if (previous.status === "rejected")
        return yield* new ThreadOrchestrationError({
          operation: "dispatch",
          code: "previously_rejected",
          message: previous.error ?? "The command was previously rejected.",
        });
      return previous.resultSequence === 0
        ? Option.none()
        : Option.some({ sequence: previous.resultSequence, storedEvents: [] });
    });
  const dispatchWithinCommandLock = (
    command: OrchestrationCommand,
    original: OrchestrationCommand | LegacyOutboxCommand = command,
  ) =>
    Effect.gen(function* () {
      if (
        command.commandId !== original.commandId ||
        command.type !== original.type ||
        ("threadId" in command && "threadId" in original && command.threadId !== original.threadId)
      ) {
        return yield* new ThreadOrchestrationError({
          operation: "dispatch",
          code: "receipt_mismatch",
          message: "Prepared legacy command must retain its original identity.",
        });
      }
      const previous = yield* resolveReceipt(original);
      if (Option.isSome(previous)) return previous.value;
      yield* preprocessing.claim(original);
      return yield* dispatchOnce(command);
    });
  const dispatch = (command: OrchestrationCommand) =>
    preprocessing.withCommandLock(command.commandId, dispatchWithinCommandLock(command));
  const mapStoredEvent = (stored: import("@t3tools/contracts").OrchestrationV2StoredEvent) => ({
    sequence: stored.sequence,
    aggregateKind: "thread" as const,
    aggregateId: stored.event.threadId,
    type:
      stored.event.type === "thread.metadata-updated" && stored.event.payload.archivedAt !== null
        ? "thread.archived"
        : stored.event.type,
    payload: stored.event.payload,
  });
  const streamError = (cause: unknown) =>
    new ThreadOrchestrationError({
      operation: "events",
      message: "Unable to subscribe to thread events.",
      cause,
    });
  const stream = sink.stream().pipe(Stream.map(mapStoredEvent), Stream.mapError(streamError));
  return {
    snapshotQuery,
    engine: {
      dispatch,
      dispatchWithinCommandLock,
      resolveReceipt,
      streamDomainEvents: stream,
      liveSubscriptionCapability: {
        subscribe: projections.getShellSnapshot().pipe(
          Effect.map((snapshot) =>
            sink
              .stream({ afterSequence: snapshot.snapshotSequence })
              .pipe(Stream.map(mapStoredEvent), Stream.mapError(streamError)),
          ),
          Effect.mapError(streamError),
        ),
      },
    },
  };
});

export interface ProjectionThreadResultContext {
  readonly thread: OrchestrationThreadShell;
  readonly project: import("@t3tools/contracts").OrchestrationProjectShell;
  readonly latestMessage: OrchestrationMessage | null;
  readonly latestAssistantMessage: OrchestrationMessage | null;
  readonly queuedMessageCount: number;
  readonly activityCount: number;
}

export class ThreadCoordinationBackend extends Context.Service<
  ThreadCoordinationBackend,
  Effect.Success<typeof makeThreadCoordinationBridge>
>()("t3/mcp/toolkits/thread-orchestration/V2Bridge/ThreadCoordinationBackend") {}

export const layer = Layer.effect(ThreadCoordinationBackend, makeThreadCoordinationBridge);
