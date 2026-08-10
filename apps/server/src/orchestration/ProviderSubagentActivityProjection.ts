import {
  CommandId,
  EventId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  defaultInstanceIdForDriver,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import {
  adjustWorkloadGauge,
  incrementWorkloadCounter,
} from "../diagnostics/WorkloadDiagnostics.ts";
import { isPersistenceError } from "../persistence/Errors.ts";
import { OrchestrationCommandReceiptRepository } from "../persistence/Services/OrchestrationCommandReceipts.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

const PUBLICATION_INTERVAL_MS = 500;
const STANDALONE_ACTIVITY_KINDS = new Set([
  "approval.requested",
  "approval.resolved",
  "user-input.requested",
  "user-input.resolved",
  "runtime.error",
  "runtime.warning",
  "tool.denied",
]);

interface ProjectionState {
  activityId: EventId;
  threadId: ThreadId;
  provider: ProviderRuntimeEvent["provider"];
  providerInstanceId: string;
  providerThreadId: string;
  parentTurnId: TurnId | null;
  turnId: TurnId | null;
  transcript: string;
  transcriptSegmentsByItemId: Map<string, Array<string>>;
  transcriptItemOrder: ReadonlyArray<string>;
  completedTranscriptItemIds: Set<string>;
  lastTranscriptItemId: string | null;
  status: "running" | "waiting" | "completed" | "failed";
  lastActivity: string | null;
  updatedAt: string;
  latestEventType: ProviderRuntimeEvent["type"];
  lastEventId: EventId;
  lastPublishedAtMs: number | null;
  authoritativeTranscriptRecovery: boolean;
  dirty: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function toTurnId(value: TurnId | string | undefined): TurnId | undefined {
  return value === undefined ? undefined : TurnId.make(String(value));
}

function eventTimeMillis(createdAt: string): number {
  const parsed = Date.parse(createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function isSubagentRuntimeEvent(
  event: ProviderRuntimeEvent,
): event is ProviderRuntimeEvent & {
  readonly agentContext: NonNullable<ProviderRuntimeEvent["agentContext"]>;
} {
  return event.agentContext !== undefined;
}

export function shouldPersistStandaloneSubagentActivity(kind: string): boolean {
  return STANDALONE_ACTIVITY_KINDS.has(kind);
}

export function subagentActivityIdForRuntime(
  threadId: ThreadId,
  event: ProviderRuntimeEvent,
  providerThreadId: string,
): EventId {
  const providerInstanceId = event.providerInstanceId ?? defaultInstanceIdForDriver(event.provider);
  return EventId.make(
    `subagent:${encodeURIComponent(threadId)}:${encodeURIComponent(event.provider)}:${encodeURIComponent(
      providerInstanceId,
    )}:${encodeURIComponent(providerThreadId)}`,
  );
}

function projectionKey(
  threadId: ThreadId,
  event: ProviderRuntimeEvent & {
    readonly agentContext: NonNullable<ProviderRuntimeEvent["agentContext"]>;
  },
): string {
  const providerInstanceId = event.providerInstanceId ?? defaultInstanceIdForDriver(event.provider);
  return `${threadId}\0${event.provider}\0${providerInstanceId}\0${event.agentContext.providerThreadId}`;
}

function statusFromEvent(event: ProviderRuntimeEvent): ProjectionState["status"] | undefined {
  if (event.type === "runtime.error") return "failed";
  if (event.type === "request.opened" || event.type === "user-input.requested") return "waiting";
  if (event.type === "request.resolved" || event.type === "user-input.resolved") return "running";
  if (event.type === "turn.completed") {
    return event.payload.state === "completed" ? "completed" : "failed";
  }
  if (event.type === "item.completed" && event.payload.itemType === "assistant_message") {
    return "completed";
  }
  return undefined;
}

function lastActivityFromEvent(event: ProviderRuntimeEvent): string | null {
  switch (event.type) {
    case "thread.started":
      return "Started";
    case "thread.state.changed":
      return `Thread ${event.payload.state}`;
    case "turn.completed":
      return event.payload.state === "failed" ? "Turn failed" : "Turn completed";
    case "item.started":
      return `${event.payload.title ?? "Tool"} started`;
    case "item.updated":
      return event.payload.title ?? event.payload.detail ?? "Tool updated";
    case "item.completed":
      return `${event.payload.title ?? "Tool"} completed`;
    case "tool.progress":
      return event.payload.summary ?? "Tool progress";
    case "request.opened":
      return "Waiting for approval";
    case "request.resolved":
      return "Approval resolved";
    case "user-input.requested":
      return "Waiting for input";
    case "user-input.resolved":
      return "Input submitted";
    case "runtime.error":
      return event.payload.message;
    default:
      return null;
  }
}

function transcriptDeltaFromEvent(event: ProviderRuntimeEvent): string {
  if (event.type === "content.delta" && event.payload.streamKind === "assistant_text") {
    return event.payload.delta;
  }
  if (
    event.type === "item.completed" &&
    event.payload.itemType === "assistant_message" &&
    event.payload.detail
  ) {
    return event.payload.detail;
  }
  return "";
}

function materializeTranscript(state: ProjectionState): string {
  return state.transcriptItemOrder
    .flatMap((key) => state.transcriptSegmentsByItemId.get(key) ?? [])
    .join("");
}

function transcriptItemMetadata(state: ProjectionState) {
  return state.transcriptItemOrder.map((itemId) => ({
    itemId,
    length: (state.transcriptSegmentsByItemId.get(itemId) ?? []).reduce(
      (total, segment) => total + segment.length,
      0,
    ),
    completed: state.completedTranscriptItemIds.has(itemId),
  }));
}

function activityCommandId(
  state: Pick<ProjectionState, "provider" | "providerInstanceId" | "lastEventId" | "activityId">,
  commandTag: string,
): CommandId {
  return CommandId.make(
    `provider:${state.provider}:${state.providerInstanceId}:${state.lastEventId}:${commandTag}:${state.activityId}`,
  );
}

function updateTranscript(state: ProjectionState, event: ProviderRuntimeEvent) {
  const itemId = String(
    event.itemId ??
      (event.type === "item.completed" ? state.lastTranscriptItemId : undefined) ??
      event.turnId ??
      event.eventId,
  );
  const previousSegments = state.transcriptSegmentsByItemId.get(itemId);
  const itemWasCompleted = state.completedTranscriptItemIds.has(itemId);
  const transcriptItemOrder =
    previousSegments === undefined
      ? [...state.transcriptItemOrder, itemId]
      : state.transcriptItemOrder;

  if (event.type === "content.delta" && event.payload.streamKind === "assistant_text") {
    if (event.payload.delta.length === 0 || itemWasCompleted) {
      return {
        changed: false,
        transcriptItemOrder: state.transcriptItemOrder,
        lastTranscriptItemId: state.lastTranscriptItemId,
      };
    }
    if (previousSegments === undefined) {
      state.transcriptSegmentsByItemId.set(itemId, [event.payload.delta]);
    } else {
      previousSegments.push(event.payload.delta);
    }
  } else if (event.type === "item.completed" && event.payload.itemType === "assistant_message") {
    if (itemWasCompleted) {
      return {
        changed: false,
        transcriptItemOrder: state.transcriptItemOrder,
        lastTranscriptItemId: itemId,
      };
    }
    state.completedTranscriptItemIds.add(itemId);
    const authoritativeText = event.payload.detail ?? "";
    if (authoritativeText.length === 0 || previousSegments?.join("") === authoritativeText) {
      return { changed: true, transcriptItemOrder, lastTranscriptItemId: itemId };
    }
    state.transcriptSegmentsByItemId.set(itemId, [authoritativeText]);
  } else {
    return {
      changed: false,
      transcriptItemOrder: state.transcriptItemOrder,
      lastTranscriptItemId: state.lastTranscriptItemId,
    };
  }
  return { changed: true, transcriptItemOrder, lastTranscriptItemId: itemId };
}

export const makeProviderSubagentActivityProjection = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const commandReceiptRepository = yield* OrchestrationCommandReceiptRepository;
  const states = new Map<string, ProjectionState>();

  const hasAuthoritativeTranscriptRecovery = Effect.fn(
    "ProviderSubagentActivityProjection.hasAuthoritativeTranscriptRecovery",
  )(function* (event: ProviderRuntimeEvent, journalBacked: boolean) {
    if (journalBacked) return true;
    const instanceId = event.providerInstanceId ?? defaultInstanceIdForDriver(event.provider);
    return yield* providerService.getCapabilities(instanceId).pipe(
      Effect.map((capabilities) => capabilities.assistantTranscriptRecovery === "authoritative"),
      Effect.orElseSucceed(() => false),
    );
  });

  const hydrate = Effect.fn("ProviderSubagentActivityProjection.hydrate")(function* (input: {
    readonly event: ProviderRuntimeEvent & {
      readonly agentContext: NonNullable<ProviderRuntimeEvent["agentContext"]>;
    };
    readonly threadId: ThreadId;
    readonly activityId: EventId;
    readonly authoritativeTranscriptRecovery: boolean;
  }) {
    const thread = yield* projectionSnapshotQuery
      .getThreadDetailById(input.threadId)
      .pipe(Effect.map(Option.getOrUndefined));
    const activity = thread?.activities.find((candidate) => candidate.id === input.activityId);
    const payload = activity ? asRecord(activity.payload) : null;
    const transcript = typeof payload?.transcript === "string" ? payload.transcript : null;
    if (!activity || !payload || transcript === null) return undefined;

    const transcriptSegmentsByItemId = new Map<string, Array<string>>();
    const transcriptItemOrder: string[] = [];
    const completedTranscriptItemIds = new Set<string>();
    const rawItems = payload.transcriptItems;
    let offset = 0;
    let metadataIsValid = Array.isArray(rawItems);
    if (Array.isArray(rawItems)) {
      for (const rawItem of rawItems) {
        const item = asRecord(rawItem);
        const itemId = typeof item?.itemId === "string" ? item.itemId : null;
        const length =
          typeof item?.length === "number" && Number.isSafeInteger(item.length) && item.length >= 0
            ? item.length
            : null;
        if (itemId === null || length === null || offset + length > transcript.length) {
          metadataIsValid = false;
          break;
        }
        transcriptItemOrder.push(itemId);
        transcriptSegmentsByItemId.set(itemId, [transcript.slice(offset, offset + length)]);
        if (item?.completed === true) completedTranscriptItemIds.add(itemId);
        offset += length;
      }
    }
    if (!metadataIsValid || offset !== transcript.length) {
      transcriptSegmentsByItemId.clear();
      transcriptItemOrder.length = 0;
      completedTranscriptItemIds.clear();
      if (transcript.length > 0) {
        const fallbackItemId = `legacy:${input.activityId}`;
        transcriptItemOrder.push(fallbackItemId);
        transcriptSegmentsByItemId.set(fallbackItemId, [transcript]);
        completedTranscriptItemIds.add(fallbackItemId);
      }
    }

    const status: ProjectionState["status"] =
      payload.status === "running" ||
      payload.status === "waiting" ||
      payload.status === "completed" ||
      payload.status === "failed"
        ? payload.status
        : "running";
    const updatedAt =
      typeof payload.updatedAt === "string" ? payload.updatedAt : activity.createdAt;
    return {
      activityId: input.activityId,
      threadId: input.threadId,
      provider: input.event.provider,
      providerInstanceId:
        input.event.providerInstanceId ?? defaultInstanceIdForDriver(input.event.provider),
      providerThreadId: input.event.agentContext.providerThreadId,
      parentTurnId:
        input.event.agentContext.parentTurnId ??
        (typeof payload.parentTurnId === "string" ? TurnId.make(payload.parentTurnId) : null),
      turnId: toTurnId(input.event.turnId) ?? activity.turnId,
      transcript,
      transcriptSegmentsByItemId,
      transcriptItemOrder,
      completedTranscriptItemIds,
      lastTranscriptItemId: transcriptItemOrder.at(-1) ?? null,
      status,
      lastActivity: typeof payload.lastActivity === "string" ? payload.lastActivity : null,
      updatedAt,
      latestEventType:
        typeof payload.latestEventType === "string"
          ? (payload.latestEventType as ProviderRuntimeEvent["type"])
          : input.event.type,
      lastEventId:
        typeof payload.latestEventId === "string"
          ? EventId.make(payload.latestEventId)
          : input.event.eventId,
      lastPublishedAtMs: eventTimeMillis(updatedAt),
      authoritativeTranscriptRecovery: input.authoritativeTranscriptRecovery,
      dirty: false,
    } satisfies ProjectionState;
  });

  const publish = (key: string, state: ProjectionState, commandTag: string) =>
    Effect.gen(function* () {
      const transcript = materializeTranscript(state);
      yield* orchestrationEngine
        .dispatch({
          type: "thread.activity.append",
          commandId: activityCommandId(state, commandTag),
          threadId: state.threadId,
          activity: {
            id: state.activityId,
            createdAt: state.updatedAt,
            tone: state.status === "failed" ? "error" : "info",
            kind: "subagent.thread",
            summary: `Subagent ${state.status}`,
            payload: {
              providerThreadId: state.providerThreadId,
              parentTurnId: state.parentTurnId,
              status: state.status,
              transcript,
              transcriptItems: transcriptItemMetadata(state),
              lastActivity: state.lastActivity,
              updatedAt: state.updatedAt,
              latestEventType: state.latestEventType,
              latestEventId: state.lastEventId,
            },
            turnId: state.parentTurnId ?? state.turnId,
          },
          createdAt: state.updatedAt,
        })
        .pipe(
          Effect.retry({
            schedule: Schedule.spaced("50 millis"),
            while: (error) => {
              if (!isPersistenceError(error)) return false;
              incrementWorkloadCounter("ingestion.activity.persistence_retries");
              return true;
            },
          }),
        );
      states.set(key, {
        ...state,
        transcript,
        lastPublishedAtMs: eventTimeMillis(state.updatedAt),
        dirty: false,
      });
      incrementWorkloadCounter("ingestion.activity.published");
      if (commandTag === "subagent-thread-activity-flush") {
        incrementWorkloadCounter("ingestion.activity.flushes");
      }
    });

  const update = Effect.fn("ProviderSubagentActivityProjection.update")(function* (
    event: ProviderRuntimeEvent & {
      readonly agentContext: NonNullable<ProviderRuntimeEvent["agentContext"]>;
    },
    journalBacked: boolean,
  ) {
    const threadId = ThreadId.make(event.threadId);
    const providerThreadId = event.agentContext.providerThreadId;
    const key = projectionKey(threadId, event);
    incrementWorkloadCounter("ingestion.activity.candidates");
    const rawTranscriptDelta = transcriptDeltaFromEvent(event);
    const statusUpdate = statusFromEvent(event);
    const lastActivityUpdate = lastActivityFromEvent(event);
    if (
      rawTranscriptDelta.length === 0 &&
      statusUpdate === undefined &&
      lastActivityUpdate === null
    ) {
      incrementWorkloadCounter("ingestion.activity.unchanged_suppressed");
      return;
    }

    const activityId = subagentActivityIdForRuntime(threadId, event, providerThreadId);
    const publicationCommandId = activityCommandId(
      {
        provider: event.provider,
        providerInstanceId: event.providerInstanceId ?? defaultInstanceIdForDriver(event.provider),
        lastEventId: event.eventId,
        activityId,
      },
      "subagent-thread-activity-upsert",
    );
    const existingReceipt = yield* commandReceiptRepository
      .getByCommandId({ commandId: publicationCommandId })
      .pipe(
        Effect.retry({
          schedule: Schedule.spaced("50 millis"),
          while: (error) => {
            if (!isPersistenceError(error)) return false;
            incrementWorkloadCounter("ingestion.activity.persistence_retries");
            return true;
          },
        }),
      );
    if (Option.isSome(existingReceipt) && existingReceipt.value.status === "accepted") {
      incrementWorkloadCounter("provider.events.duplicates_suppressed");
      return;
    }

    const existingState = states.get(key);
    const authoritativeTranscriptRecovery =
      existingState?.authoritativeTranscriptRecovery === true ||
      (yield* hasAuthoritativeTranscriptRecovery(event, journalBacked));
    const hydratedState =
      existingState ??
      (yield* hydrate({ event, threadId, activityId, authoritativeTranscriptRecovery }));
    const existing: ProjectionState = hydratedState ?? {
      activityId,
      threadId,
      provider: event.provider,
      providerInstanceId: event.providerInstanceId ?? defaultInstanceIdForDriver(event.provider),
      providerThreadId,
      parentTurnId: event.agentContext.parentTurnId ?? null,
      turnId: toTurnId(event.turnId) ?? null,
      transcript: "",
      transcriptSegmentsByItemId: new Map<string, Array<string>>(),
      transcriptItemOrder: [],
      completedTranscriptItemIds: new Set<string>(),
      lastTranscriptItemId: null,
      status: "running",
      lastActivity: null,
      updatedAt: "",
      latestEventType: event.type,
      lastEventId: event.eventId,
      lastPublishedAtMs: null,
      authoritativeTranscriptRecovery,
      dirty: false,
    };
    const status = statusUpdate ?? existing.status;
    const lastActivity = lastActivityUpdate ?? existing.lastActivity;
    const transcriptUpdate = updateTranscript(existing, event);
    const parentTurnId = event.agentContext.parentTurnId ?? existing.parentTurnId;
    const turnId = toTurnId(event.turnId) ?? existing.turnId;
    const semanticallyChanged =
      transcriptUpdate.changed ||
      status !== existing.status ||
      lastActivity !== existing.lastActivity ||
      parentTurnId !== existing.parentTurnId ||
      turnId !== existing.turnId;
    if (!semanticallyChanged) {
      incrementWorkloadCounter("ingestion.activity.unchanged_suppressed");
      return;
    }
    if (existingState === undefined) adjustWorkloadGauge("ingestion.subagent_coalescers.active", 1);

    const nextState: ProjectionState = {
      ...existing,
      transcriptItemOrder: transcriptUpdate.transcriptItemOrder,
      lastTranscriptItemId: transcriptUpdate.lastTranscriptItemId,
      status,
      lastActivity,
      parentTurnId,
      turnId,
      updatedAt: event.createdAt,
      latestEventType: event.type,
      lastEventId: event.eventId,
      dirty: true,
    };
    const elapsedSincePublication =
      existing.lastPublishedAtMs === null
        ? Number.POSITIVE_INFINITY
        : eventTimeMillis(event.createdAt) - existing.lastPublishedAtMs;
    const shouldPublish =
      existing.lastPublishedAtMs === null ||
      status !== existing.status ||
      (transcriptUpdate.changed && !existing.authoritativeTranscriptRecovery) ||
      elapsedSincePublication >= PUBLICATION_INTERVAL_MS;
    states.set(key, nextState);
    if (!shouldPublish) {
      incrementWorkloadCounter("ingestion.activity.coalesced");
      return;
    }
    yield* publish(key, nextState, "subagent-thread-activity-upsert").pipe(
      Effect.tapError(() => Effect.sync(() => states.set(key, nextState))),
    );
  });

  const flush = (input?: {
    readonly threadId?: ThreadId;
    readonly turnId?: TurnId;
    readonly terminalStatus?: ProjectionState["status"];
    readonly event?: ProviderRuntimeEvent;
    readonly clear?: boolean;
  }) =>
    Effect.suspend(() =>
      Effect.forEach(
        Array.from(states.keys()),
        (key) =>
          Effect.gen(function* () {
            const state = states.get(key);
            if (state === undefined) return;
            if (input?.threadId !== undefined && state.threadId !== input.threadId) return;
            if (
              input?.turnId !== undefined &&
              state.parentTurnId !== input.turnId &&
              state.turnId !== input.turnId
            ) {
              return;
            }
            const terminalStatus = input?.terminalStatus ?? state.status;
            const event = input?.event;
            const nextState: ProjectionState = {
              ...state,
              status: terminalStatus,
              ...(event
                ? {
                    updatedAt: event.createdAt,
                    latestEventType: event.type,
                    lastEventId: event.eventId,
                  }
                : {}),
              dirty:
                state.dirty ||
                terminalStatus !== state.status ||
                (event !== undefined &&
                  (event.type !== state.latestEventType || event.eventId !== state.lastEventId)),
            };
            if (nextState.dirty) {
              yield* publish(key, nextState, "subagent-thread-activity-flush");
            }
            if (input?.clear === true) {
              states.delete(key);
              adjustWorkloadGauge("ingestion.subagent_coalescers.active", -1);
            }
          }),
        { concurrency: 1, discard: true },
      ),
    );

  const finalize = flush({ clear: true }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        adjustWorkloadGauge("ingestion.subagent_coalescers.active", -states.size);
        states.clear();
      }),
    ),
  );

  return { update, flush, finalize } as const;
});
