import {
  ApprovalRequestId,
  type AssistantDeliveryMode,
  CommandId,
  EventId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationMessage,
  type OrchestrationProposedPlanId,
  CheckpointRef,
  classifyTaskAgentKind,
  isToolLifecycleItemType,
  ThreadId,
  type ThreadTokenUsageSnapshot,
  TurnId,
  type OrchestrationCheckpointSummary,
  type OrchestrationProposedPlan,
  type OrchestrationThread,
  type OrchestrationActivityImageMedia,
  type OrchestrationThreadActivity,
  type ProviderRuntimeEvent,
  defaultInstanceIdForDriver,
} from "@t3tools/contracts";
import Mime from "@effect/platform-node/Mime";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { makeKeyedDrainableWorker } from "@t3tools/shared/KeyedDrainableWorker";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProviderTranscriptJournalLive } from "../../persistence/Layers/ProviderTranscriptJournal.ts";
import { isGitRepository } from "../../git/Utils.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ThreadBackgroundLivenessService } from "../ThreadBackgroundLiveness.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderRuntimeIngestionService,
  type ProviderRuntimeIngestionShape,
} from "../Services/ProviderRuntimeIngestion.ts";
import { forkParked } from "../../serverActivation.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ServerConfig } from "../../config.ts";
import { inferImageExtension } from "../../imageMime.ts";
import { createObservedMediaId, resolveObservedMediaPath } from "../../observedMediaStore.ts";
import {
  adjustWorkloadGauge,
  incrementWorkloadCounter,
} from "../../diagnostics/WorkloadDiagnostics.ts";
import { isPersistenceError } from "../../persistence/Errors.ts";
import { ProviderTranscriptJournal } from "../../persistence/Services/ProviderTranscriptJournal.ts";
import { isTranscriptDurabilityEvent } from "../../provider/ProviderRuntimeEventDurability.ts";
import {
  makeTranscriptJournalTracker,
  observeTranscriptJournalBatch,
  TranscriptJournalTracker,
  type TranscriptJournalIngestionPhase,
} from "../../observability/TranscriptJournalObservability.ts";
import {
  batchProviderTranscriptJournalEntries,
  isBatchableParentAssistantDelta,
  type ProviderTranscriptJournalBatch,
} from "../ProviderTranscriptJournalBatch.ts";

const providerTurnKey = (threadId: ThreadId, turnId: TurnId) => `${threadId}:${turnId}`;
const providerTaskKey = (threadId: ThreadId, taskId: string) => `${threadId}:${taskId}`;

// Fallback when the in-memory description cache no longer has the task name
// (server restart, session-exit sweep, TTL/capacity eviction): earlier
// task.started/task.progress activities for the task are persisted with it.
function findTaskTitleInActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity> | undefined,
  taskId: string,
): string | undefined {
  if (!activities) {
    return undefined;
  }
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || (activity.kind !== "task.started" && activity.kind !== "task.progress")) {
      continue;
    }
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as { taskId?: unknown; title?: unknown; detail?: unknown })
        : undefined;
    if (payload?.taskId !== taskId) {
      continue;
    }
    const title =
      typeof payload.title === "string"
        ? payload.title
        : activity.kind === "task.started" && typeof payload.detail === "string"
          ? payload.detail
          : undefined;
    if (title && title.trim().length > 0) {
      return title;
    }
  }
  return undefined;
}

interface AssistantSegmentState {
  baseKey: string;
  nextSegmentIndex: number;
  activeMessageId: MessageId | null;
}

interface SubagentProjectionState {
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

interface SubagentTranscriptItemMetadata {
  readonly itemId: string;
  readonly length: number;
  readonly completed: boolean;
}

const TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY = 10_000;
const TURN_MESSAGE_IDS_BY_TURN_TTL = Duration.minutes(120);
const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY = 20_000;
const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL = Duration.minutes(120);
const BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY = 10_000;
const BUFFERED_PROPOSED_PLAN_BY_ID_TTL = Duration.minutes(120);
const TASK_DESCRIPTION_BY_TASK_CACHE_CAPACITY = 10_000;
const TASK_DESCRIPTION_BY_TASK_TTL = Duration.minutes(120);
const SUBAGENT_PUBLICATION_INTERVAL_MS = 500;
const MAX_BUFFERED_ASSISTANT_CHARS = 24_000;
const STRICT_PROVIDER_LIFECYCLE_GUARD = process.env.T3CODE_STRICT_PROVIDER_LIFECYCLE_GUARD !== "0";

type TurnStartRequestedDomainEvent = Extract<
  OrchestrationEvent,
  { type: "thread.turn-start-requested" }
>;

type RuntimeIngestionInput =
  | {
      source: "runtime";
      event: ProviderRuntimeEvent;
    }
  | {
      source: "domain";
      event: TurnStartRequestedDomainEvent;
    };

function toTurnId(value: TurnId | string | undefined): TurnId | undefined {
  return value === undefined ? undefined : TurnId.make(String(value));
}

function toApprovalRequestId(value: string | undefined): ApprovalRequestId | undefined {
  return value === undefined ? undefined : ApprovalRequestId.make(value);
}

function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

function hasAssistantMessageForTurn(
  messages: ReadonlyArray<OrchestrationMessage>,
  turnId: TurnId,
  options?: { readonly streamingOnly?: boolean },
): boolean {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    if (message.role !== "assistant" || message.turnId !== turnId) {
      continue;
    }
    if (options?.streamingOnly === true && !message.streaming) {
      continue;
    }
    return true;
  }
  return false;
}

function findMessageById(
  messages: ReadonlyArray<OrchestrationMessage>,
  messageId: MessageId,
): OrchestrationMessage | undefined {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.id === messageId) {
      return message;
    }
  }
  return undefined;
}

function findProposedPlanById(
  proposedPlans: ReadonlyArray<
    Pick<OrchestrationProposedPlan, "id" | "createdAt" | "implementedAt" | "implementationThreadId">
  >,
  planId: string,
):
  | Pick<OrchestrationProposedPlan, "id" | "createdAt" | "implementedAt" | "implementationThreadId">
  | undefined {
  for (let index = 0; index < proposedPlans.length; index += 1) {
    const proposedPlan = proposedPlans[index];
    if (proposedPlan?.id === planId) {
      return proposedPlan;
    }
  }
  return undefined;
}

function hasCheckpointForTurn(
  checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>,
  turnId: TurnId,
): boolean {
  for (let index = 0; index < checkpoints.length; index += 1) {
    if (checkpoints[index]?.turnId === turnId) {
      return true;
    }
  }
  return false;
}

function maxCheckpointTurnCount(
  checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>,
): number {
  let maxTurnCount = 0;
  for (let index = 0; index < checkpoints.length; index += 1) {
    const checkpoint = checkpoints[index];
    if (checkpoint && checkpoint.checkpointTurnCount > maxTurnCount) {
      maxTurnCount = checkpoint.checkpointTurnCount;
    }
  }
  return maxTurnCount;
}

function truncateDetail(value: string, limit = 180): string {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

const MAX_ACTIVITY_DATA_STRING_CHARS = 12_000;
const MAX_ACTIVITY_DATA_ARRAY_ITEMS = 200;
const MAX_ACTIVITY_DATA_OBJECT_KEYS = 100;
const SUBAGENT_STANDALONE_ACTIVITY_KINDS = new Set([
  "approval.requested",
  "approval.resolved",
  "user-input.requested",
  "user-input.resolved",
  "runtime.error",
  "runtime.warning",
  "tool.denied",
]);

function compactActivityData(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    if (value.length <= MAX_ACTIVITY_DATA_STRING_CHARS) {
      return value;
    }
    return `${value.slice(0, MAX_ACTIVITY_DATA_STRING_CHARS)}\n[truncated ${
      value.length - MAX_ACTIVITY_DATA_STRING_CHARS
    } chars]`;
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (depth >= 6) {
    return "[truncated nested activity data]";
  }

  if (Array.isArray(value)) {
    const compacted = value
      .slice(0, MAX_ACTIVITY_DATA_ARRAY_ITEMS)
      .map((entry) => compactActivityData(entry, depth + 1));
    if (value.length > MAX_ACTIVITY_DATA_ARRAY_ITEMS) {
      compacted.push(`[truncated ${value.length - MAX_ACTIVITY_DATA_ARRAY_ITEMS} items]`);
    }
    return compacted;
  }

  const compacted: Record<string, unknown> = {};
  const entries = Object.entries(value);
  for (const [key, entryValue] of entries.slice(0, MAX_ACTIVITY_DATA_OBJECT_KEYS)) {
    compacted[key] = compactActivityData(entryValue, depth + 1);
  }
  if (entries.length > MAX_ACTIVITY_DATA_OBJECT_KEYS) {
    compacted.__truncatedKeys = entries.length - MAX_ACTIVITY_DATA_OBJECT_KEYS;
  }
  return compacted;
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

function subagentProjectionKey(
  threadId: ThreadId,
  event: ProviderRuntimeEvent & {
    readonly agentContext: NonNullable<ProviderRuntimeEvent["agentContext"]>;
  },
): string {
  const providerInstanceId = event.providerInstanceId ?? defaultInstanceIdForDriver(event.provider);
  return `${threadId}\0${event.provider}\0${providerInstanceId}\0${event.agentContext.providerThreadId}`;
}

function runtimeSessionKey(event: ProviderRuntimeEvent): string {
  const providerInstanceId = event.providerInstanceId ?? defaultInstanceIdForDriver(event.provider);
  return `${event.provider}\0${providerInstanceId}\0${event.threadId}`;
}

function runtimeEventScopeKey(event: ProviderRuntimeEvent): string {
  const turnScope = `turn:${event.turnId ?? "session"}`;
  if (event.itemId !== undefined) {
    return `${turnScope}\0item:${event.itemId}`;
  }
  if (
    event.type === "content.delta" ||
    event.type === "item.started" ||
    event.type === "item.updated" ||
    event.type === "item.completed"
  ) {
    return `${turnScope}\0item:anonymous`;
  }
  return `${turnScope}\0lifecycle:${event.type}`;
}

function transcriptItemScopeKey(event: ProviderRuntimeEvent): string | null {
  if (event.itemId === undefined) return null;
  return `${event.provider}\0${event.providerInstanceId ?? defaultInstanceIdForDriver(event.provider)}\0${event.threadId}\0${event.turnId ?? ""}\0${event.itemId}`;
}

function runtimeTurnScopePrefix(turnId: TurnId | string): string {
  return `turn:${turnId}\0`;
}

interface RuntimeSessionDedupeState {
  readonly activeEventIdsByScope: Map<string, Set<string>>;
  readonly completedItemScopes: Set<string>;
  readonly completedTurnIds: Set<string>;
}

function eventTimeMillis(createdAt: string): number {
  const parsed = Date.parse(createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isSubagentRuntimeEvent(event: ProviderRuntimeEvent): event is ProviderRuntimeEvent & {
  readonly agentContext: NonNullable<ProviderRuntimeEvent["agentContext"]>;
} {
  return event.agentContext !== undefined;
}

function subagentStatusFromRuntimeEvent(
  event: ProviderRuntimeEvent,
): SubagentProjectionState["status"] | undefined {
  if (event.type === "runtime.error") {
    return "failed";
  }
  if (event.type === "request.opened" || event.type === "user-input.requested") {
    return "waiting";
  }
  if (event.type === "request.resolved" || event.type === "user-input.resolved") {
    return "running";
  }
  if (event.type === "turn.completed") {
    return event.payload.state === "completed" ? "completed" : "failed";
  }
  if (event.type === "item.completed" && event.payload.itemType === "assistant_message") {
    return "completed";
  }
  return undefined;
}

function subagentLastActivityFromRuntimeEvent(event: ProviderRuntimeEvent): string | null {
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

function subagentTranscriptDeltaFromRuntimeEvent(event: ProviderRuntimeEvent): string {
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

function materializeSubagentTranscript(
  state: Pick<SubagentProjectionState, "transcriptSegmentsByItemId" | "transcriptItemOrder">,
): string {
  return state.transcriptItemOrder
    .flatMap((key) => state.transcriptSegmentsByItemId.get(key) ?? [])
    .join("");
}

function subagentTranscriptItemMetadata(
  state: Pick<
    SubagentProjectionState,
    "transcriptSegmentsByItemId" | "transcriptItemOrder" | "completedTranscriptItemIds"
  >,
): ReadonlyArray<SubagentTranscriptItemMetadata> {
  return state.transcriptItemOrder.map((itemId) => ({
    itemId,
    length: (state.transcriptSegmentsByItemId.get(itemId) ?? []).reduce(
      (total, segment) => total + segment.length,
      0,
    ),
    completed: state.completedTranscriptItemIds.has(itemId),
  }));
}

function subagentActivityCommandId(
  state: Pick<
    SubagentProjectionState,
    "provider" | "providerInstanceId" | "lastEventId" | "activityId"
  >,
  commandTag: string,
): CommandId {
  return CommandId.make(
    `provider:${state.provider}:${state.providerInstanceId}:${state.lastEventId}:${commandTag}:${state.activityId}`,
  );
}

function updateSubagentTranscript(
  state: Pick<
    SubagentProjectionState,
    | "transcriptSegmentsByItemId"
    | "transcriptItemOrder"
    | "lastTranscriptItemId"
    | "completedTranscriptItemIds"
  >,
  event: ProviderRuntimeEvent,
): {
  readonly changed: boolean;
  readonly transcriptItemOrder: ReadonlyArray<string>;
  readonly lastTranscriptItemId: string | null;
} {
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
      return {
        changed: true,
        transcriptItemOrder,
        lastTranscriptItemId: itemId,
      };
    }
    // Authoritative completion replaces this item's streamed segments in O(1).
    // Full transcript materialization is reserved for durable publication.
    state.transcriptSegmentsByItemId.set(itemId, [authoritativeText]);
  } else {
    return {
      changed: false,
      transcriptItemOrder: state.transcriptItemOrder,
      lastTranscriptItemId: state.lastTranscriptItemId,
    };
  }
  return {
    transcriptItemOrder,
    lastTranscriptItemId: itemId,
    changed: true,
  };
}

function runtimeAgentContextPayload(event: ProviderRuntimeEvent):
  | {
      readonly agentContext: NonNullable<ProviderRuntimeEvent["agentContext"]>;
    }
  | Record<string, never> {
  if (!isSubagentRuntimeEvent(event)) {
    return {};
  }
  return {
    agentContext: event.agentContext,
  };
}

function subagentAwareSummary(event: ProviderRuntimeEvent, summary: string): string {
  return isSubagentRuntimeEvent(event) ? `Subagent ${summary.toLowerCase()}` : summary;
}

function normalizeProposedPlanMarkdown(planMarkdown: string | undefined): string | undefined {
  const trimmed = planMarkdown?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
}

function hasRenderableAssistantText(text: string | undefined): boolean {
  return (text?.trim().length ?? 0) > 0;
}

function proposedPlanIdForTurn(threadId: ThreadId, turnId: TurnId): string {
  return `plan:${threadId}:turn:${turnId}`;
}

function proposedPlanIdFromEvent(event: ProviderRuntimeEvent, threadId: ThreadId): string {
  const turnId = toTurnId(event.turnId);
  if (turnId) {
    return proposedPlanIdForTurn(threadId, turnId);
  }
  if (event.itemId) {
    return `plan:${threadId}:item:${event.itemId}`;
  }
  return `plan:${threadId}:event:${event.eventId}`;
}

function assistantSegmentBaseKeyFromEvent(event: ProviderRuntimeEvent): string {
  return String(event.itemId ?? event.turnId ?? event.eventId);
}

function assistantSegmentMessageId(baseKey: string, segmentIndex: number): MessageId {
  return MessageId.make(
    segmentIndex === 0 ? `assistant:${baseKey}` : `assistant:${baseKey}:segment:${segmentIndex}`,
  );
}
function buildContextWindowActivityPayload(
  event: ProviderRuntimeEvent,
): ThreadTokenUsageSnapshot | undefined {
  if (event.type !== "thread.token-usage.updated" || event.payload.usage.usedTokens <= 0) {
    return undefined;
  }
  return event.payload.usage;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function observedImageSourcePathFromActivity(activity: OrchestrationThreadActivity): string | null {
  const payload = asRecord(activity.payload);
  if (payload?.itemType !== "image_view") {
    return null;
  }

  const data = asRecord(payload.data);
  const item = asRecord(data?.item);
  return (
    asString(item?.path) ??
    asString(item?.savedPath) ??
    asString(data?.path) ??
    asString(data?.savedPath) ??
    asString(payload.detail)
  );
}

function isLocalObservedImagePath(sourcePath: string): boolean {
  const normalizedPath = sourcePath.trim().toLowerCase();
  return (
    normalizedPath.length > 0 &&
    !normalizedPath.startsWith("data:") &&
    !normalizedPath.startsWith("http://") &&
    !normalizedPath.startsWith("https://")
  );
}

function existingObservedActivityMedia(
  payload: Record<string, unknown>,
): ReadonlyArray<OrchestrationActivityImageMedia> {
  const rawMedia = payload.media;
  if (!Array.isArray(rawMedia)) {
    return [];
  }

  return rawMedia.flatMap((item): ReadonlyArray<OrchestrationActivityImageMedia> => {
    const record = asRecord(item);
    const type = record?.type;
    const id = asString(record?.id);
    const name = asString(record?.name);
    const mimeType = asString(record?.mimeType);
    const storageId = asString(record?.storageId);
    if (type !== "image" || !id || !name || !mimeType || !storageId) {
      return [];
    }
    return [
      {
        type: "image",
        id,
        name,
        mimeType,
        storageId,
        ...(asFiniteNumber(record?.sizeBytes) !== null
          ? { sizeBytes: asFiniteNumber(record?.sizeBytes)! }
          : {}),
        ...(asString(record?.originalPath)
          ? { originalPath: asString(record?.originalPath)! }
          : {}),
      },
    ];
  });
}

function normalizeRateLimitResetTimestamp(value: unknown): string | null {
  const text = asString(value);
  if (text) {
    return Option.match(DateTime.make(text), {
      onNone: () => null,
      onSome: DateTime.formatIso,
    });
  }

  const raw = asFiniteNumber(value);
  if (raw === null || raw <= 0) {
    return null;
  }
  const epochMs = raw >= 1_000_000_000_000 ? raw : raw * 1000;
  return Option.match(DateTime.make(epochMs), {
    onNone: () => null,
    onSome: DateTime.formatIso,
  });
}

function normalizeRateLimitWindow(value: unknown): {
  readonly usedPercent: number;
  readonly resetsAt: string | null;
  readonly windowDurationMins: number | null;
} | null {
  const record = asRecord(value);
  const usedPercent = asFiniteNumber(record?.usedPercent);
  if (usedPercent === null) {
    return null;
  }

  return {
    usedPercent,
    resetsAt: normalizeRateLimitResetTimestamp(record?.resetsAt),
    windowDurationMins: asFiniteNumber(record?.windowDurationMins),
  };
}

function normalizeSpendControlLimitWindow(value: unknown): {
  readonly usedPercent: number;
  readonly resetsAt: string | null;
  readonly windowDurationMins: number | null;
} | null {
  const record = asRecord(value);
  const remainingPercent = asFiniteNumber(record?.remainingPercent);
  if (remainingPercent === null) {
    return null;
  }

  return {
    usedPercent: Math.max(0, Math.min(100, 100 - remainingPercent)),
    resetsAt: normalizeRateLimitResetTimestamp(record?.resetsAt),
    windowDurationMins: null,
  };
}

function selectSecondaryRateLimitWindow(
  secondary: {
    readonly usedPercent: number;
    readonly resetsAt: string | null;
    readonly windowDurationMins: number | null;
  } | null,
  individualLimit: {
    readonly usedPercent: number;
    readonly resetsAt: string | null;
    readonly windowDurationMins: number | null;
  } | null,
): {
  readonly usedPercent: number;
  readonly resetsAt: string | null;
  readonly windowDurationMins: number | null;
} | null {
  if (!secondary) {
    return individualLimit;
  }
  if (secondary.usedPercent === 0 && individualLimit && individualLimit.usedPercent > 0) {
    return individualLimit;
  }
  return secondary;
}

function hasRateLimitSnapshotFields(value: Record<string, unknown>): boolean {
  return (
    value.primary !== undefined ||
    value.secondary !== undefined ||
    value.individualLimit !== undefined ||
    value.limitId !== undefined ||
    value.limitName !== undefined ||
    value.planType !== undefined ||
    value.rateLimitReachedType !== undefined ||
    value.credits !== undefined
  );
}

function unwrapRateLimitSnapshot(value: unknown): Record<string, unknown> | null {
  let current = asRecord(value);
  for (let depth = 0; depth < 3; depth += 1) {
    if (!current) {
      return null;
    }
    if (hasRateLimitSnapshotFields(current)) {
      return current;
    }
    const nested = asRecord(current.rateLimits);
    if (!nested) {
      return current;
    }
    current = nested;
  }
  return current;
}

function buildUsageLimitsSnapshot(event: ProviderRuntimeEvent):
  | {
      readonly limitId: string | null;
      readonly limitName: string | null;
      readonly planType: string | null;
      readonly rateLimitReachedType: string | null;
      readonly credits: {
        readonly balance: string | null;
        readonly hasCredits: boolean;
        readonly unlimited: boolean;
      } | null;
      readonly primary: {
        readonly usedPercent: number;
        readonly resetsAt: string | null;
        readonly windowDurationMins: number | null;
      } | null;
      readonly secondary: {
        readonly usedPercent: number;
        readonly resetsAt: string | null;
        readonly windowDurationMins: number | null;
      } | null;
      readonly updatedAt: string;
    }
  | undefined {
  if (event.type !== "account.rate-limits.updated") {
    return undefined;
  }

  const rateLimits = unwrapRateLimitSnapshot(event.payload.rateLimits);
  if (!rateLimits) {
    return undefined;
  }

  const creditsRecord = asRecord(rateLimits.credits);
  const hasCredits = asBoolean(creditsRecord?.hasCredits);
  const unlimited = asBoolean(creditsRecord?.unlimited);
  const credits =
    hasCredits !== null && unlimited !== null
      ? {
          balance: asString(creditsRecord?.balance),
          hasCredits,
          unlimited,
        }
      : null;

  const primary = normalizeRateLimitWindow(rateLimits.primary);
  const secondary = selectSecondaryRateLimitWindow(
    normalizeRateLimitWindow(rateLimits.secondary),
    normalizeSpendControlLimitWindow(rateLimits.individualLimit),
  );
  if (
    primary === null &&
    secondary === null &&
    asString(rateLimits.limitId) === null &&
    asString(rateLimits.limitName) === null &&
    asString(rateLimits.planType) === null &&
    asString(rateLimits.rateLimitReachedType) === null &&
    credits === null
  ) {
    return undefined;
  }

  return {
    limitId: asString(rateLimits.limitId),
    limitName: asString(rateLimits.limitName),
    planType: asString(rateLimits.planType),
    rateLimitReachedType: asString(rateLimits.rateLimitReachedType),
    credits,
    primary,
    secondary,
    updatedAt: event.createdAt,
  };
}

function normalizeRuntimeTurnState(
  value: string | undefined,
): "completed" | "failed" | "interrupted" | "cancelled" {
  switch (value) {
    case "failed":
    case "interrupted":
    case "cancelled":
    case "completed":
      return value;
    default:
      return "completed";
  }
}

function orchestrationSessionStatusFromRuntimeState(
  state: "starting" | "running" | "waiting" | "ready" | "interrupted" | "stopped" | "error",
): "starting" | "running" | "ready" | "interrupted" | "stopped" | "error" {
  switch (state) {
    case "starting":
      return "starting";
    case "running":
    case "waiting":
      return "running";
    case "ready":
      return "ready";
    case "interrupted":
      return "interrupted";
    case "stopped":
      return "stopped";
    case "error":
      return "error";
  }
}

function sessionStatusAllowsActiveTurn(
  status: ReturnType<typeof orchestrationSessionStatusFromRuntimeState>,
): boolean {
  return status === "starting" || status === "running";
}

function requestKindFromCanonicalRequestType(
  requestType: string | undefined,
): "command" | "file-read" | "file-change" | undefined {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    default:
      return undefined;
  }
}

/**
 * Copies the optional TaskAgentLinkage bundle from a task.* runtime payload
 * into the persisted activity payload. Identity fields ride on every row so
 * client folds survive activity retention; absent fields stay absent.
 */
function taskLinkageActivityFields(payload: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    // Server-stamped classification: persisted rows are self-describing, so
    // clients trust the stamp instead of re-deriving agent-vs-background
    // from taskType denylists and marker heuristics (legacy rows without a
    // stamp keep the client fallback).
    agentKind: classifyTaskAgentKind({
      taskType: typeof payload.taskType === "string" ? payload.taskType : undefined,
      agentId: typeof payload.agentId === "string" ? payload.agentId : undefined,
    }),
  };
  for (const key of [
    "taskType",
    "agentId",
    "title",
    "role",
    "model",
    "effort",
    "toolUseId",
    "parentAgentId",
    "workflowName",
    "agentIndex",
    "phaseIndex",
    "phaseTitle",
    "phases",
    "attempt",
    "runHandles",
    "outputFile",
    "agentPath",
    "timelineBypass",
    "typedUsage",
    "status",
    "error",
  ] as const) {
    if (payload[key] !== undefined) {
      fields[key] = payload[key];
    }
  }
  return fields;
}

export function runtimeEventToActivities(
  event: ProviderRuntimeEvent,
  taskTitle?: string,
): ReadonlyArray<OrchestrationThreadActivity> {
  const maybeSequence = (() => {
    const eventWithSequence = event as ProviderRuntimeEvent & { sessionSequence?: number };
    return eventWithSequence.sessionSequence !== undefined
      ? { sequence: eventWithSequence.sessionSequence }
      : {};
  })();
  switch (event.type) {
    case "request.opened": {
      if (event.payload.requestType === "tool_user_input") {
        return [];
      }
      const requestKind = requestKindFromCanonicalRequestType(event.payload.requestType);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "approval",
          kind: "approval.requested",
          summary: subagentAwareSummary(
            event,
            requestKind === "command"
              ? "Command approval requested"
              : requestKind === "file-read"
                ? "File-read approval requested"
                : requestKind === "file-change"
                  ? "File-change approval requested"
                  : "Approval requested",
          ),
          payload: {
            requestId: toApprovalRequestId(event.requestId),
            ...(requestKind ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.payload.detail ? { detail: event.payload.detail } : {}),
            ...runtimeAgentContextPayload(event),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "request.resolved": {
      if (event.payload.requestType === "tool_user_input") {
        return [];
      }
      const requestKind = requestKindFromCanonicalRequestType(event.payload.requestType);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "approval",
          kind: "approval.resolved",
          summary: subagentAwareSummary(event, "Approval resolved"),
          payload: {
            requestId: toApprovalRequestId(event.requestId),
            ...(requestKind ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.payload.decision ? { decision: event.payload.decision } : {}),
            ...runtimeAgentContextPayload(event),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "runtime.error": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "error",
          kind: "runtime.error",
          summary: subagentAwareSummary(event, "Runtime error"),
          payload: {
            message: truncateDetail(event.payload.message),
            ...runtimeAgentContextPayload(event),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "tool.denied": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "error",
          kind: "tool.denied",
          summary: `Tool denied: ${event.payload.toolName}`,
          payload: {
            toolName: event.payload.toolName,
            ...(event.payload.toolUseId ? { toolUseId: event.payload.toolUseId } : {}),
            ...(event.payload.reason ? { detail: truncateDetail(event.payload.reason) } : {}),
            ...(event.payload.agentId ? { agentId: event.payload.agentId } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "runtime.warning": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "runtime.warning",
          // Use the adapter-supplied message as the row label so the work log
          // shows what the warning was about, not a generic "Runtime warning".
          summary: truncateDetail(event.payload.message, 120),
          payload: {
            message: truncateDetail(event.payload.message),
            ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "turn.plan.updated": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "turn.plan.updated",
          summary: "Plan updated",
          payload: {
            plan: event.payload.plan,
            ...(event.payload.explanation !== undefined
              ? { explanation: event.payload.explanation }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "user-input.requested": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "user-input.requested",
          summary: subagentAwareSummary(event, "User input requested"),
          payload: {
            ...(event.requestId ? { requestId: event.requestId } : {}),
            questions: event.payload.questions,
            ...runtimeAgentContextPayload(event),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "user-input.resolved": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "user-input.resolved",
          summary: subagentAwareSummary(event, "User input submitted"),
          payload: {
            ...(event.requestId ? { requestId: event.requestId } : {}),
            answers: event.payload.answers,
            ...runtimeAgentContextPayload(event),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.started": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "task.started",
          summary:
            event.payload.taskType === "plan"
              ? "Plan task started"
              : event.payload.taskType
                ? `${event.payload.taskType} task started`
                : "Task started",
          payload: {
            taskId: event.payload.taskId,
            ...(event.payload.taskType ? { taskType: event.payload.taskType } : {}),
            ...(event.payload.description
              ? { detail: truncateDetail(event.payload.description) }
              : {}),
            ...taskLinkageActivityFields(event.payload as Record<string, unknown>),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.progress": {
      return [
        {
          // Stable per-task id: progress is "latest state", not history, so
          // each tick REPLACES the last via the activity upsert (PK + the
          // replace-by-id apply in projector and client reducer). Keeps one
          // progress row per task instead of thousands, so a large fleet's
          // ticks can no longer evict its own start/terminal rows out of
          // the 500-row retention window. Thread-scoped: activity_id is a
          // GLOBAL primary key and Claude task ids are session-local, so a
          // bare taskId could collide across threads and steal another
          // thread's row (review finding).
          id: EventId.make(`task-progress:${event.threadId}:${event.payload.taskId}`),
          createdAt: event.createdAt,
          tone: "info",
          kind: "task.progress",
          summary:
            event.payload.description.trim().length > 0
              ? truncateDetail(event.payload.description, 120)
              : "Reasoning update",
          payload: {
            taskId: event.payload.taskId,
            ...(event.payload.description.trim().length > 0
              ? { title: truncateDetail(event.payload.description, 120) }
              : {}),
            detail: truncateDetail(event.payload.summary ?? event.payload.description),
            ...(event.payload.summary ? { summary: truncateDetail(event.payload.summary) } : {}),
            ...(event.payload.lastToolName ? { lastToolName: event.payload.lastToolName } : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
            ...taskLinkageActivityFields(event.payload as Record<string, unknown>),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.updated": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: event.payload.status === "failed" ? "error" : "info",
          kind: "task.updated",
          summary:
            event.payload.status === "failed"
              ? "Task failed"
              : event.payload.status
                ? `Task ${event.payload.status}`
                : "Task updated",
          payload: {
            taskId: event.payload.taskId,
            ...(event.payload.description
              ? { detail: truncateDetail(event.payload.description) }
              : {}),
            ...(event.payload.endedAt ? { endedAt: event.payload.endedAt } : {}),
            ...(event.payload.isBackgrounded !== undefined
              ? { isBackgrounded: event.payload.isBackgrounded }
              : {}),
            ...taskLinkageActivityFields(event.payload as Record<string, unknown>),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "tool.progress": {
      // Only agent-owned heartbeats are persisted: they feed the owning
      // agent's activity line. Parent-conversation tool progress stays
      // ephemeral (item lifecycle already covers it).
      if (event.payload.taskId === undefined) {
        return [];
      }
      return [
        {
          // Same stable-id treatment as task.progress: a heartbeat is
          // "what is this agent doing right now", so one row per task
          // (thread-scoped for the same global-PK collision reason).
          id: EventId.make(`tool-progress:${event.threadId}:${event.payload.taskId}`),
          createdAt: event.createdAt,
          tone: "info",
          kind: "tool.progress",
          summary: event.payload.toolName ?? "Tool progress",
          payload: {
            taskId: event.payload.taskId,
            ...(event.payload.toolName ? { toolName: event.payload.toolName } : {}),
            ...(event.payload.toolUseId ? { toolUseId: event.payload.toolUseId } : {}),
            ...(event.payload.elapsedSeconds !== undefined
              ? { elapsedSeconds: event.payload.elapsedSeconds }
              : {}),
            ...(event.payload.parentToolUseId
              ? { parentToolUseId: event.payload.parentToolUseId }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.completed": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: event.payload.status === "failed" ? "error" : "info",
          kind: "task.completed",
          summary:
            event.payload.status === "failed"
              ? "Task failed"
              : event.payload.status === "stopped"
                ? "Task stopped"
                : "Task completed",
          payload: {
            taskId: event.payload.taskId,
            status: event.payload.status,
            ...(taskTitle ? { title: truncateDetail(taskTitle, 120) } : {}),
            // summary + detail mirror task.progress: clients label the row from
            // summary and keep detail for the preview/expanded body.
            ...(event.payload.summary
              ? {
                  summary: truncateDetail(event.payload.summary),
                  detail: truncateDetail(event.payload.summary),
                }
              : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
            ...taskLinkageActivityFields(event.payload as Record<string, unknown>),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "thread.state.changed": {
      if (event.payload.state !== "compacted") {
        return [];
      }

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "context-compaction",
          summary: "Context compacted",
          payload: {
            state: event.payload.state,
            ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "thread.token-usage.updated": {
      const payload = buildContextWindowActivityPayload(event);
      if (!payload) {
        return [];
      }

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "context-window.updated",
          summary: "Context window updated",
          payload,
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.updated": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.updated",
          summary: event.payload.title ?? "Tool updated",
          payload: {
            itemType: event.payload.itemType,
            ...(event.payload.status ? { status: event.payload.status } : {}),
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(event.payload.data !== undefined
              ? { data: compactActivityData(event.payload.data) }
              : {}),
            ...(event.payload.agentId ? { agentId: event.payload.agentId } : {}),
            ...(event.payload.parentToolUseId
              ? { parentToolUseId: event.payload.parentToolUseId }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.completed": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.completed",
          summary: event.payload.title ?? "Tool",
          payload: {
            itemType: event.payload.itemType,
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(event.payload.data !== undefined
              ? { data: compactActivityData(event.payload.data) }
              : {}),
            ...(event.payload.agentId ? { agentId: event.payload.agentId } : {}),
            ...(event.payload.parentToolUseId
              ? { parentToolUseId: event.payload.parentToolUseId }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.started": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.started",
          summary: `${event.payload.title ?? "Tool"} started`,
          payload: {
            itemType: event.payload.itemType,
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(event.payload.agentId ? { agentId: event.payload.agentId } : {}),
            ...(event.payload.parentToolUseId
              ? { parentToolUseId: event.payload.parentToolUseId }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    default:
      break;
  }

  return [];
}

const make = Effect.gen(function* () {
  const threadBackgroundLiveness = yield* ThreadBackgroundLivenessService;
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const commandReceiptRepository = yield* OrchestrationCommandReceiptRepository;
  const transcriptJournal = yield* ProviderTranscriptJournal;
  const transcriptJournalTrackerOption = yield* Effect.serviceOption(TranscriptJournalTracker);
  const transcriptJournalTracker = Option.isSome(transcriptJournalTrackerOption)
    ? transcriptJournalTrackerOption.value
    : yield* makeTranscriptJournalTracker;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const serverSettingsService = yield* ServerSettingsService;
  const serverConfig = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const providerCommandId = (event: ProviderRuntimeEvent, tag: string) =>
    Effect.succeed(
      CommandId.make(
        `provider:${event.provider}:${
          event.providerInstanceId ?? defaultInstanceIdForDriver(event.provider)
        }:${encodeURIComponent(event.threadId)}:${event.eventId}:${tag}`,
      ),
    );
  const processedRuntimeEventsBySession = new Map<string, RuntimeSessionDedupeState>();
  const recoveringTranscriptJournalCountByScope = new Map<string, number>();
  const durableParentDeltaPromotions = new Map<string, Array<ProviderRuntimeEvent>>();
  const journalBatchSourcesByEventId = new Map<string, ReadonlyArray<ProviderRuntimeEvent>>();

  const journalSourceEvents = (event: ProviderRuntimeEvent) =>
    journalBatchSourcesByEventId.get(String(event.eventId)) ?? [event];

  const hasProcessedRuntimeEvent = (event: ProviderRuntimeEvent): boolean => {
    const state = processedRuntimeEventsBySession.get(runtimeSessionKey(event));
    if (state === undefined) return false;
    if (event.turnId !== undefined && state.completedTurnIds.has(String(event.turnId))) return true;
    const scopeKey = runtimeEventScopeKey(event);
    return (
      state.completedItemScopes.has(scopeKey) ||
      (state.activeEventIdsByScope.get(scopeKey)?.has(String(event.eventId)) ?? false)
    );
  };

  const rememberProcessedRuntimeEvent = (event: ProviderRuntimeEvent) =>
    Effect.sync(() => {
      const sessionKey = runtimeSessionKey(event);
      if (event.type === "session.exited") {
        const existing = processedRuntimeEventsBySession.get(sessionKey);
        if (existing !== undefined) {
          const retainedEventCount = Array.from(existing.activeEventIdsByScope.values()).reduce(
            (total, eventIds) => total + eventIds.size,
            0,
          );
          adjustWorkloadGauge("ingestion.dedupe.events.active", -retainedEventCount);
        }
        processedRuntimeEventsBySession.delete(sessionKey);
        return;
      }
      const state = processedRuntimeEventsBySession.get(sessionKey) ?? {
        activeEventIdsByScope: new Map<string, Set<string>>(),
        completedItemScopes: new Set<string>(),
        completedTurnIds: new Set<string>(),
      };
      const scopeKey = runtimeEventScopeKey(event);
      const eventIds = state.activeEventIdsByScope.get(scopeKey) ?? new Set<string>();
      if (!eventIds.has(String(event.eventId))) {
        eventIds.add(String(event.eventId));
        adjustWorkloadGauge("ingestion.dedupe.events.active", 1);
      }
      state.activeEventIdsByScope.set(scopeKey, eventIds);

      if (event.type === "item.completed" && event.itemId !== undefined) {
        state.activeEventIdsByScope.delete(scopeKey);
        adjustWorkloadGauge("ingestion.dedupe.events.active", -eventIds.size);
        state.completedItemScopes.add(scopeKey);
      }
      if (event.type === "turn.completed" || event.type === "turn.aborted") {
        const turnId = event.turnId;
        if (turnId !== undefined) {
          const prefix = runtimeTurnScopePrefix(turnId);
          for (const [candidateScope, candidateEventIds] of state.activeEventIdsByScope) {
            if (!candidateScope.startsWith(prefix)) continue;
            state.activeEventIdsByScope.delete(candidateScope);
            adjustWorkloadGauge("ingestion.dedupe.events.active", -candidateEventIds.size);
          }
          for (const candidateScope of state.completedItemScopes) {
            if (candidateScope.startsWith(prefix)) state.completedItemScopes.delete(candidateScope);
          }
          state.completedTurnIds.add(String(turnId));
        }
      }
      processedRuntimeEventsBySession.set(sessionKey, state);
    });

  const turnMessageIdsByTurnKey = yield* Cache.make<string, Set<MessageId>>({
    capacity: TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY,
    timeToLive: TURN_MESSAGE_IDS_BY_TURN_TTL,
    lookup: () => Effect.succeed(new Set<MessageId>()),
  });

  const bufferedAssistantTextByMessageId = yield* Cache.make<MessageId, string>({
    capacity: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL,
    lookup: () => Effect.succeed(""),
  });

  const assistantSegmentStateByTurnKey = yield* Cache.make<string, AssistantSegmentState>({
    capacity: TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY,
    timeToLive: TURN_MESSAGE_IDS_BY_TURN_TTL,
    lookup: () =>
      Effect.die(
        new Error("assistant segment state should be read through getOption before initialization"),
      ),
  });

  const bufferedProposedPlanById = yield* Cache.make<string, { text: string; createdAt: string }>({
    capacity: BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_PROPOSED_PLAN_BY_ID_TTL,
    lookup: () => Effect.succeed({ text: "", createdAt: "" }),
  });

  // Task names arrive on task.started/task.progress but not on task.completed,
  // so remember them per task to title the completion activity.
  const taskDescriptionByTaskKey = yield* Cache.make<string, string>({
    capacity: TASK_DESCRIPTION_BY_TASK_CACHE_CAPACITY,
    timeToLive: TASK_DESCRIPTION_BY_TASK_TTL,
    lookup: () => Effect.succeed(""),
  });

  const rememberTaskDescription = (threadId: ThreadId, taskId: string, description: string) =>
    Cache.set(taskDescriptionByTaskKey, providerTaskKey(threadId, taskId), description);

  // Entries are left in place after completion so replayed or duplicate
  // terminal events stay titled; TTL, capacity, and the session-exit sweep
  // bound the cache.
  const lookupTaskDescription = (threadId: ThreadId, taskId: string) =>
    Cache.getOption(taskDescriptionByTaskKey, providerTaskKey(threadId, taskId)).pipe(
      Effect.map((description) =>
        Option.filter(description, (value) => value.length > 0).pipe(Option.getOrUndefined),
      ),
    );

  // This state is lossless until an explicit lifecycle flush. A TTL/capacity
  // cache can evict a dirty coalescer without an effectful finalizer, losing
  // transcript bytes and leaking its active gauge.
  const subagentStates = new Map<string, SubagentProjectionState>();
  const bufferedAssistantJournalEventsByMessageId = new Map<
    MessageId,
    Array<ProviderRuntimeEvent>
  >();

  const resolveThreadDetail = Effect.fn("resolveThreadDetail")(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThreadShell = Effect.fn("resolveThreadShell")(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadShellById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const readAuthoritativeTranscriptRecoveryCapability = Effect.fn(
    "readAuthoritativeTranscriptRecoveryCapability",
  )(function* (event: ProviderRuntimeEvent) {
    const instanceId = event.providerInstanceId ?? defaultInstanceIdForDriver(event.provider);
    return yield* providerService.getCapabilities(instanceId).pipe(
      Effect.map((capabilities) => capabilities.assistantTranscriptRecovery === "authoritative"),
      // Capability lookup failure must choose the lossless path. Volatile
      // coalescing is an optimization that requires positive proof.
      Effect.orElseSucceed(() => false),
    );
  });

  const hydrateSubagentState = Effect.fn("hydrateSubagentState")(function* (input: {
    readonly event: ProviderRuntimeEvent & {
      readonly agentContext: NonNullable<ProviderRuntimeEvent["agentContext"]>;
    };
    readonly threadId: ThreadId;
    readonly activityId: EventId;
    readonly authoritativeTranscriptRecovery: boolean;
  }) {
    const thread = yield* resolveThreadDetail(input.threadId);
    const activity = thread?.activities.find((candidate) => candidate.id === input.activityId);
    const payload = activity ? asRecord(activity.payload) : null;
    const transcript = typeof payload?.transcript === "string" ? payload.transcript : null;
    if (!activity || !payload || transcript === null) {
      return undefined;
    }

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
        // Never bind a legacy cumulative transcript to the incoming item. A
        // later authoritative completion for that item must not replace and
        // erase pre-metadata bytes recovered during an upgrade.
        const fallbackItemId = `legacy:${input.activityId}`;
        transcriptItemOrder.push(fallbackItemId);
        transcriptSegmentsByItemId.set(fallbackItemId, [transcript]);
        completedTranscriptItemIds.add(fallbackItemId);
      }
    }

    const status: SubagentProjectionState["status"] =
      payload.status === "running" ||
      payload.status === "waiting" ||
      payload.status === "completed" ||
      payload.status === "failed"
        ? payload.status
        : "running";
    const updatedAt =
      typeof payload.updatedAt === "string" ? payload.updatedAt : activity.createdAt;
    const latestEventType =
      typeof payload.latestEventType === "string"
        ? (payload.latestEventType as ProviderRuntimeEvent["type"])
        : input.event.type;
    const lastEventId =
      typeof payload.latestEventId === "string"
        ? EventId.make(payload.latestEventId)
        : input.event.eventId;

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
      latestEventType,
      lastEventId,
      lastPublishedAtMs: eventTimeMillis(updatedAt),
      authoritativeTranscriptRecovery: input.authoritativeTranscriptRecovery,
      dirty: false,
    };
  });

  const rememberAssistantMessageId = (threadId: ThreadId, turnId: TurnId, messageId: MessageId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.flatMap((existingIds) =>
        Cache.set(
          turnMessageIdsByTurnKey,
          providerTurnKey(threadId, turnId),
          Option.match(existingIds, {
            onNone: () => new Set([messageId]),
            onSome: (ids) => {
              const nextIds = new Set(ids);
              nextIds.add(messageId);
              return nextIds;
            },
          }),
        ),
      ),
    );

  const forgetAssistantMessageId = (threadId: ThreadId, turnId: TurnId, messageId: MessageId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.flatMap((existingIds) =>
        Option.match(existingIds, {
          onNone: () => Effect.void,
          onSome: (ids) => {
            const nextIds = new Set(ids);
            nextIds.delete(messageId);
            if (nextIds.size === 0) {
              return Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId));
            }
            return Cache.set(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId), nextIds);
          },
        }),
      ),
    );

  const getAssistantMessageIdsForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.map((existingIds) =>
        Option.getOrElse(existingIds, (): Set<MessageId> => new Set<MessageId>()),
      ),
    );

  const clearAssistantMessageIdsForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId));

  const getAssistantSegmentStateForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.getOption(assistantSegmentStateByTurnKey, providerTurnKey(threadId, turnId));

  const setAssistantSegmentStateForTurn = (
    threadId: ThreadId,
    turnId: TurnId,
    state: AssistantSegmentState,
  ) => Cache.set(assistantSegmentStateByTurnKey, providerTurnKey(threadId, turnId), state);

  const clearAssistantSegmentStateForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.invalidate(assistantSegmentStateByTurnKey, providerTurnKey(threadId, turnId));

  const getActiveAssistantMessageIdForTurn = (threadId: ThreadId, turnId: TurnId) =>
    getAssistantSegmentStateForTurn(threadId, turnId).pipe(
      Effect.map((state) =>
        Option.flatMap(state, (entry) =>
          entry.activeMessageId ? Option.some(entry.activeMessageId) : Option.none(),
        ),
      ),
    );

  const startAssistantSegmentForTurn = (input: {
    threadId: ThreadId;
    turnId: TurnId;
    baseKey: string;
  }) =>
    getAssistantSegmentStateForTurn(input.threadId, input.turnId).pipe(
      Effect.flatMap((existingState) =>
        Effect.gen(function* () {
          const nextState = Option.match(existingState, {
            onNone: () => ({
              baseKey: input.baseKey,
              nextSegmentIndex: 1,
              activeMessageId: assistantSegmentMessageId(input.baseKey, 0),
            }),
            onSome: (state) => {
              const segmentIndex = state.baseKey === input.baseKey ? state.nextSegmentIndex : 0;
              const messageId = assistantSegmentMessageId(input.baseKey, segmentIndex);
              return {
                baseKey: input.baseKey,
                nextSegmentIndex: state.baseKey === input.baseKey ? state.nextSegmentIndex + 1 : 1,
                activeMessageId: messageId,
              } satisfies AssistantSegmentState;
            },
          });
          yield* setAssistantSegmentStateForTurn(input.threadId, input.turnId, nextState);
          return nextState.activeMessageId!;
        }),
      ),
    );

  const getOrCreateAssistantMessageId = (input: {
    threadId: ThreadId;
    event: ProviderRuntimeEvent;
    turnId?: TurnId;
  }) =>
    Effect.gen(function* () {
      if (!input.turnId) {
        return assistantSegmentMessageId(assistantSegmentBaseKeyFromEvent(input.event), 0);
      }

      const activeMessageId = yield* getActiveAssistantMessageIdForTurn(
        input.threadId,
        input.turnId,
      );
      if (Option.isSome(activeMessageId)) {
        return activeMessageId.value;
      }

      return yield* startAssistantSegmentForTurn({
        threadId: input.threadId,
        turnId: input.turnId,
        baseKey: assistantSegmentBaseKeyFromEvent(input.event),
      });
    });

  const appendBufferedAssistantText = (messageId: MessageId, delta: string) =>
    Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.flatMap((existingText) =>
        Effect.gen(function* () {
          const nextText = Option.match(existingText, {
            onNone: () => delta,
            onSome: (text) => `${text}${delta}`,
          });
          if (nextText.length <= MAX_BUFFERED_ASSISTANT_CHARS) {
            yield* Cache.set(bufferedAssistantTextByMessageId, messageId, nextText);
            return "";
          }

          // Safety valve: flush full buffered text as an assistant delta to cap memory.
          yield* Cache.invalidate(bufferedAssistantTextByMessageId, messageId);
          return nextText;
        }),
      ),
    );

  const takeBufferedAssistantText = (messageId: MessageId) =>
    Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.flatMap((existingText) =>
        Cache.invalidate(bufferedAssistantTextByMessageId, messageId).pipe(
          Effect.as(Option.getOrElse(existingText, () => "")),
        ),
      ),
    );

  const clearBufferedAssistantText = (messageId: MessageId) =>
    Cache.invalidate(bufferedAssistantTextByMessageId, messageId);

  const appendBufferedProposedPlan = (planId: string, delta: string, createdAt: string) =>
    Cache.getOption(bufferedProposedPlanById, planId).pipe(
      Effect.flatMap((existingEntry) => {
        const existing = Option.getOrUndefined(existingEntry);
        return Cache.set(bufferedProposedPlanById, planId, {
          text: `${existing?.text ?? ""}${delta}`,
          createdAt:
            existing?.createdAt && existing.createdAt.length > 0 ? existing.createdAt : createdAt,
        });
      }),
    );

  const takeBufferedProposedPlan = (planId: string) =>
    Cache.getOption(bufferedProposedPlanById, planId).pipe(
      Effect.flatMap((existingEntry) =>
        Cache.invalidate(bufferedProposedPlanById, planId).pipe(
          Effect.as(Option.getOrUndefined(existingEntry)),
        ),
      ),
    );

  const clearBufferedProposedPlan = (planId: string) =>
    Cache.invalidate(bufferedProposedPlanById, planId);

  const enrichObservedImageActivity = (input: {
    readonly activity: OrchestrationThreadActivity;
    readonly threadId: ThreadId;
  }): Effect.Effect<OrchestrationThreadActivity> =>
    Effect.gen(function* () {
      const payload = asRecord(input.activity.payload);
      const sourcePath = observedImageSourcePathFromActivity(input.activity);
      if (!payload || !sourcePath || !isLocalObservedImagePath(sourcePath)) {
        return input.activity;
      }

      const mimeType = Mime.getType(sourcePath);
      if (!mimeType?.toLowerCase().startsWith("image/")) {
        return input.activity;
      }

      const mediaId = createObservedMediaId(input.threadId);
      if (!mediaId) {
        return input.activity;
      }

      const bytes = yield* fileSystem.readFile(sourcePath);
      const extension = inferImageExtension({ mimeType, fileName: sourcePath });
      const targetPath = resolveObservedMediaPath({
        observedMediaDir: serverConfig.observedMediaDir,
        mediaId,
        extension,
      });
      if (!targetPath) {
        return input.activity;
      }

      yield* fileSystem.makeDirectory(path.dirname(targetPath), { recursive: true });
      yield* fileSystem.writeFile(targetPath, bytes);

      const observedMedia: OrchestrationActivityImageMedia = {
        type: "image",
        id: mediaId,
        name: path.basename(sourcePath) || "image",
        mimeType,
        storageId: mediaId,
        sizeBytes: bytes.byteLength,
        originalPath: sourcePath,
      };

      return {
        ...input.activity,
        payload: {
          ...payload,
          media: [...existingObservedActivityMedia(payload), observedMedia],
        },
      };
    }).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("Failed to persist observed image for work-log preview", {
          cause,
          activityId: input.activity.id,
        }),
      ),
      Effect.orElseSucceed(() => input.activity),
    );

  const appendActivities = (
    event: ProviderRuntimeEvent,
    threadId: ThreadId,
    activities: ReadonlyArray<OrchestrationThreadActivity>,
  ) =>
    Effect.forEach(activities, (activity) =>
      enrichObservedImageActivity({ activity, threadId }).pipe(
        Effect.flatMap((enrichedActivity) =>
          providerCommandId(event, `thread-activity-append:${enrichedActivity.id}`).pipe(
            Effect.flatMap((commandId) =>
              orchestrationEngine.dispatch({
                type: "thread.activity.append",
                commandId,
                threadId,
                activity: enrichedActivity,
                createdAt: enrichedActivity.createdAt,
              }),
            ),
          ),
        ),
      ),
    ).pipe(Effect.asVoid);

  const publishSubagentActivity = (
    key: string,
    state: SubagentProjectionState,
    commandTag: string,
  ) =>
    Effect.gen(function* () {
      const transcript = materializeSubagentTranscript(state);
      yield* orchestrationEngine
        .dispatch({
          type: "thread.activity.append",
          commandId: subagentActivityCommandId(state, commandTag),
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
              transcriptItems: subagentTranscriptItemMetadata(state),
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
      subagentStates.set(key, {
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

  const updateSubagentActivity = (input: { event: ProviderRuntimeEvent; threadId: ThreadId }) =>
    Effect.gen(function* () {
      if (!isSubagentRuntimeEvent(input.event)) {
        return;
      }

      const agentContext = input.event.agentContext;
      const providerThreadId = agentContext.providerThreadId;
      const key = subagentProjectionKey(input.threadId, input.event);
      incrementWorkloadCounter("ingestion.activity.candidates");
      const rawTranscriptDelta = subagentTranscriptDeltaFromRuntimeEvent(input.event);
      const statusUpdate = subagentStatusFromRuntimeEvent(input.event);
      const lastActivityUpdate = subagentLastActivityFromRuntimeEvent(input.event);
      if (
        rawTranscriptDelta.length === 0 &&
        statusUpdate === undefined &&
        lastActivityUpdate === null
      ) {
        incrementWorkloadCounter("ingestion.activity.unchanged_suppressed");
        return;
      }

      const activityId = subagentActivityIdForRuntime(
        input.threadId,
        input.event,
        providerThreadId,
      );
      const publicationCommandId = subagentActivityCommandId(
        {
          provider: input.event.provider,
          providerInstanceId:
            input.event.providerInstanceId ?? defaultInstanceIdForDriver(input.event.provider),
          lastEventId: input.event.eventId,
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

      const existingState = subagentStates.get(key);
      const authoritativeTranscriptRecovery =
        existingState?.authoritativeTranscriptRecovery ??
        (yield* readAuthoritativeTranscriptRecoveryCapability(input.event));
      const hydratedState =
        existingState ??
        (yield* hydrateSubagentState({
          event: input.event,
          threadId: input.threadId,
          activityId,
          authoritativeTranscriptRecovery,
        }));
      const existing = hydratedState ?? {
        activityId,
        threadId: input.threadId,
        provider: input.event.provider,
        providerInstanceId:
          input.event.providerInstanceId ?? defaultInstanceIdForDriver(input.event.provider),
        providerThreadId,
        parentTurnId: agentContext.parentTurnId ?? null,
        turnId: toTurnId(input.event.turnId) ?? null,
        transcript: "",
        transcriptSegmentsByItemId: new Map<string, Array<string>>(),
        transcriptItemOrder: [],
        completedTranscriptItemIds: new Set<string>(),
        lastTranscriptItemId: null,
        status: "running" as const,
        lastActivity: null,
        updatedAt: "",
        latestEventType: input.event.type,
        lastEventId: input.event.eventId,
        lastPublishedAtMs: null,
        authoritativeTranscriptRecovery,
        dirty: false,
      };
      const status = statusUpdate ?? existing.status;
      const lastActivity = lastActivityUpdate ?? existing.lastActivity;
      const transcriptUpdate = updateSubagentTranscript(existing, input.event);
      const parentTurnId = agentContext.parentTurnId ?? existing.parentTurnId;
      const turnId = toTurnId(input.event.turnId) ?? existing.turnId;
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
      if (existingState === undefined) {
        adjustWorkloadGauge("ingestion.subagent_coalescers.active", 1);
      }

      const nextState: SubagentProjectionState = {
        ...existing,
        transcriptItemOrder: transcriptUpdate.transcriptItemOrder,
        lastTranscriptItemId: transcriptUpdate.lastTranscriptItemId,
        status,
        lastActivity,
        parentTurnId,
        turnId,
        updatedAt: input.event.createdAt,
        latestEventType: input.event.type,
        lastEventId: input.event.eventId,
        dirty: true,
      };
      const elapsedSincePublication =
        existing.lastPublishedAtMs === null
          ? Number.POSITIVE_INFINITY
          : eventTimeMillis(input.event.createdAt) - existing.lastPublishedAtMs;
      const shouldPublish =
        existing.lastPublishedAtMs === null ||
        status !== existing.status ||
        (transcriptUpdate.changed && !existing.authoritativeTranscriptRecovery) ||
        elapsedSincePublication >= SUBAGENT_PUBLICATION_INTERVAL_MS;

      if (!shouldPublish) {
        subagentStates.set(key, nextState);
        incrementWorkloadCounter("ingestion.activity.coalesced");
        return;
      }

      subagentStates.set(key, nextState);
      yield* publishSubagentActivity(key, nextState, "subagent-thread-activity-upsert").pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            // Retain the dirty state for a later terminal/drain retry. Rolling
            // back would discard transcript segments already accepted in O(1).
            subagentStates.set(key, nextState);
          }),
        ),
      );
    });

  const flushSubagentActivities = (input?: {
    readonly threadId?: ThreadId;
    readonly turnId?: TurnId;
    readonly terminalStatus?: SubagentProjectionState["status"];
    readonly event?: ProviderRuntimeEvent;
    readonly clear?: boolean;
  }) =>
    Effect.gen(function* () {
      const keys = Array.from(subagentStates.keys());
      yield* Effect.forEach(
        keys,
        (key) =>
          Effect.gen(function* () {
            const state = subagentStates.get(key);
            if (state === undefined) {
              return;
            }
            if (input?.threadId !== undefined && state.threadId !== input.threadId) {
              return;
            }
            if (
              input?.turnId !== undefined &&
              state.parentTurnId !== input.turnId &&
              state.turnId !== input.turnId
            ) {
              return;
            }
            const terminalStatus = input?.terminalStatus ?? state.status;
            const event = input?.event;
            const nextState: SubagentProjectionState = {
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
            if (!nextState.dirty) {
              if (input?.clear === true) {
                subagentStates.delete(key);
                adjustWorkloadGauge("ingestion.subagent_coalescers.active", -1);
              }
              return;
            }
            yield* publishSubagentActivity(key, nextState, "subagent-thread-activity-flush");
            if (input?.clear === true) {
              subagentStates.delete(key);
              adjustWorkloadGauge("ingestion.subagent_coalescers.active", -1);
            }
          }),
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
    });

  const rememberBufferedAssistantJournalEvent = (
    messageId: MessageId,
    event: ProviderRuntimeEvent,
  ) => {
    const events = bufferedAssistantJournalEventsByMessageId.get(messageId);
    if (events === undefined) {
      bufferedAssistantJournalEventsByMessageId.set(messageId, [event]);
    } else {
      events.push(event);
    }
  };

  const takeBufferedAssistantJournalEvents = (messageId: MessageId) => {
    const events = bufferedAssistantJournalEventsByMessageId.get(messageId) ?? [];
    bufferedAssistantJournalEventsByMessageId.delete(messageId);
    return events;
  };

  const markParentJournalEventsDurable = (
    boundaryEvent: ProviderRuntimeEvent,
    events: ReadonlyArray<ProviderRuntimeEvent>,
  ) => {
    if (events.length === 0) return;
    const key = String(boundaryEvent.eventId);
    const existing = durableParentDeltaPromotions.get(key);
    if (existing === undefined) {
      durableParentDeltaPromotions.set(key, [...events]);
    } else {
      existing.push(...events);
    }
  };

  const clearAssistantMessageState = (messageId: MessageId) =>
    clearBufferedAssistantText(messageId).pipe(
      Effect.tap(() =>
        Effect.sync(() => bufferedAssistantJournalEventsByMessageId.delete(messageId)),
      ),
    );

  const flushBufferedAssistantMessage = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    messageId: MessageId;
    turnId?: TurnId;
    createdAt: string;
    commandTag: string;
  }) =>
    Effect.gen(function* () {
      const bufferedText = yield* takeBufferedAssistantText(input.messageId);
      const journalEvents = takeBufferedAssistantJournalEvents(input.messageId);
      if (!hasRenderableAssistantText(bufferedText)) {
        markParentJournalEventsDurable(input.event, journalEvents);
        return false;
      }

      yield* orchestrationEngine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: yield* providerCommandId(input.event, `${input.commandTag}:${input.messageId}`),
        threadId: input.threadId,
        messageId: input.messageId,
        delta: bufferedText,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        createdAt: input.createdAt,
      });
      markParentJournalEventsDurable(input.event, journalEvents);
      return true;
    });

  const flushBufferedAssistantMessagesForTurn = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    turnId: TurnId;
    createdAt: string;
    commandTag: string;
  }) =>
    Effect.gen(function* () {
      const assistantMessageIds = yield* getAssistantMessageIdsForTurn(
        input.threadId,
        input.turnId,
      );
      const flushedMessageIds = new Set<MessageId>();
      yield* Effect.forEach(
        assistantMessageIds,
        (messageId) =>
          flushBufferedAssistantMessage({
            event: input.event,
            threadId: input.threadId,
            messageId,
            turnId: input.turnId,
            createdAt: input.createdAt,
            commandTag: input.commandTag,
          }).pipe(
            Effect.tap((flushed) =>
              flushed ? Effect.sync(() => flushedMessageIds.add(messageId)) : Effect.void,
            ),
          ),
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      return flushedMessageIds;
    });

  const finalizeAssistantMessage = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    messageId: MessageId;
    turnId?: TurnId;
    createdAt: string;
    commandTag: string;
    finalDeltaCommandTag: string;
    fallbackText?: string;
    hasProjectedMessage?: boolean;
  }) =>
    Effect.gen(function* () {
      const bufferedText = yield* takeBufferedAssistantText(input.messageId);
      const journalEvents = takeBufferedAssistantJournalEvents(input.messageId);
      let text = bufferedText;
      if (text.length === 0 && (input.fallbackText?.trim().length ?? 0) > 0) {
        text = input.fallbackText ?? "";
      }
      const hasRenderableText = hasRenderableAssistantText(text);

      if (hasRenderableText) {
        yield* orchestrationEngine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: yield* providerCommandId(
            input.event,
            `${input.finalDeltaCommandTag}:${input.messageId}`,
          ),
          threadId: input.threadId,
          messageId: input.messageId,
          delta: text,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          createdAt: input.createdAt,
        });
      }

      if (input.hasProjectedMessage || hasRenderableText) {
        yield* orchestrationEngine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: yield* providerCommandId(
            input.event,
            `${input.commandTag}:${input.messageId}`,
          ),
          threadId: input.threadId,
          messageId: input.messageId,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          createdAt: input.createdAt,
        });
      }
      markParentJournalEventsDurable(input.event, journalEvents);
      yield* clearAssistantMessageState(input.messageId);
    });

  const finalizeActiveAssistantSegmentForTurn = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    turnId: TurnId;
    createdAt: string;
    commandTag: string;
    finalDeltaCommandTag: string;
    hasProjectedMessage: boolean;
    flushedMessageIds?: ReadonlySet<MessageId>;
  }) =>
    Effect.gen(function* () {
      const activeMessageId = yield* getActiveAssistantMessageIdForTurn(
        input.threadId,
        input.turnId,
      );
      if (Option.isNone(activeMessageId)) {
        return;
      }

      yield* finalizeAssistantMessage({
        event: input.event,
        threadId: input.threadId,
        messageId: activeMessageId.value,
        turnId: input.turnId,
        createdAt: input.createdAt,
        commandTag: input.commandTag,
        finalDeltaCommandTag: input.finalDeltaCommandTag,
        hasProjectedMessage:
          input.hasProjectedMessage ||
          (input.flushedMessageIds?.has(activeMessageId.value) ?? false),
      });
      yield* forgetAssistantMessageId(input.threadId, input.turnId, activeMessageId.value);

      const state = yield* getAssistantSegmentStateForTurn(input.threadId, input.turnId);
      if (Option.isSome(state)) {
        yield* setAssistantSegmentStateForTurn(input.threadId, input.turnId, {
          ...state.value,
          activeMessageId: null,
        });
      }
    });

  const upsertProposedPlan = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    threadProposedPlans: ReadonlyArray<{
      id: string;
      createdAt: string;
      implementedAt: string | null;
      implementationThreadId: ThreadId | null;
    }>;
    planId: string;
    turnId?: TurnId;
    planMarkdown: string | undefined;
    createdAt: string;
    updatedAt: string;
  }) =>
    Effect.gen(function* () {
      const planMarkdown = normalizeProposedPlanMarkdown(input.planMarkdown);
      if (!planMarkdown) {
        return;
      }

      const existingPlan = findProposedPlanById(input.threadProposedPlans, input.planId);
      yield* orchestrationEngine.dispatch({
        type: "thread.proposed-plan.upsert",
        commandId: yield* providerCommandId(input.event, "proposed-plan-upsert"),
        threadId: input.threadId,
        proposedPlan: {
          id: input.planId,
          turnId: input.turnId ?? null,
          planMarkdown,
          implementedAt: existingPlan?.implementedAt ?? null,
          implementationThreadId: existingPlan?.implementationThreadId ?? null,
          createdAt: existingPlan?.createdAt ?? input.createdAt,
          updatedAt: input.updatedAt,
        },
        createdAt: input.updatedAt,
      });
    });

  const finalizeBufferedProposedPlan = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    threadProposedPlans: ReadonlyArray<{
      id: string;
      createdAt: string;
      implementedAt: string | null;
      implementationThreadId: ThreadId | null;
    }>;
    planId: string;
    turnId?: TurnId;
    fallbackMarkdown?: string;
    updatedAt: string;
  }) =>
    Effect.gen(function* () {
      const bufferedPlan = yield* takeBufferedProposedPlan(input.planId);
      const bufferedMarkdown = normalizeProposedPlanMarkdown(bufferedPlan?.text);
      const fallbackMarkdown = normalizeProposedPlanMarkdown(input.fallbackMarkdown);
      const planMarkdown = bufferedMarkdown ?? fallbackMarkdown;
      if (!planMarkdown) {
        return;
      }

      yield* upsertProposedPlan({
        event: input.event,
        threadId: input.threadId,
        threadProposedPlans: input.threadProposedPlans,
        planId: input.planId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        planMarkdown,
        createdAt:
          bufferedPlan?.createdAt && bufferedPlan.createdAt.length > 0
            ? bufferedPlan.createdAt
            : input.updatedAt,
        updatedAt: input.updatedAt,
      });
      yield* clearBufferedProposedPlan(input.planId);
    });

  const clearTurnStateForSession = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const prefix = `${threadId}:`;
      const proposedPlanPrefix = `plan:${threadId}:`;
      const turnKeys = Array.from(yield* Cache.keys(turnMessageIdsByTurnKey));
      const assistantSegmentKeys = Array.from(yield* Cache.keys(assistantSegmentStateByTurnKey));
      const proposedPlanKeys = Array.from(yield* Cache.keys(bufferedProposedPlanById));
      const taskDescriptionKeys = Array.from(yield* Cache.keys(taskDescriptionByTaskKey));
      yield* Effect.forEach(
        turnKeys,
        (key) =>
          Effect.gen(function* () {
            if (!key.startsWith(prefix)) {
              return;
            }

            const messageIds = yield* Cache.getOption(turnMessageIdsByTurnKey, key);
            if (Option.isSome(messageIds)) {
              yield* Effect.forEach(messageIds.value, clearAssistantMessageState, {
                concurrency: 1,
              }).pipe(Effect.asVoid);
            }

            yield* Cache.invalidate(turnMessageIdsByTurnKey, key);
          }),
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* Effect.forEach(
        assistantSegmentKeys,
        (key) =>
          key.startsWith(prefix)
            ? Cache.invalidate(assistantSegmentStateByTurnKey, key)
            : Effect.void,
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* Effect.forEach(
        proposedPlanKeys,
        (key) =>
          key.startsWith(proposedPlanPrefix)
            ? Cache.invalidate(bufferedProposedPlanById, key)
            : Effect.void,
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* Effect.forEach(
        taskDescriptionKeys,
        (key) =>
          key.startsWith(prefix) ? Cache.invalidate(taskDescriptionByTaskKey, key) : Effect.void,
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
    });

  const getSourceProposedPlanReferenceForPendingTurnStart = Effect.fn(
    "getSourceProposedPlanReferenceForPendingTurnStart",
  )(function* (threadId: ThreadId) {
    const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByThreadId({
      threadId,
    });
    if (Option.isNone(pendingTurnStart)) {
      return null;
    }

    const sourceThreadId = pendingTurnStart.value.sourceProposedPlanThreadId;
    const sourcePlanId = pendingTurnStart.value.sourceProposedPlanId;
    if (sourceThreadId === null || sourcePlanId === null) {
      return null;
    }

    return {
      sourceThreadId,
      sourcePlanId,
    } as const;
  });

  const getExpectedProviderTurnIdForThread = Effect.fn("getExpectedProviderTurnIdForThread")(
    function* (threadId: ThreadId) {
      const sessions = yield* providerService.listSessions();
      const session = sessions.find((entry) => entry.threadId === threadId);
      return session?.activeTurnId;
    },
  );

  const getSourceProposedPlanReferenceForAcceptedTurnStart = Effect.fn(
    "getSourceProposedPlanReferenceForAcceptedTurnStart",
  )(function* (threadId: ThreadId, eventTurnId: TurnId | undefined) {
    if (eventTurnId === undefined) {
      return null;
    }

    const expectedTurnId = yield* getExpectedProviderTurnIdForThread(threadId);
    if (!sameId(expectedTurnId, eventTurnId)) {
      return null;
    }

    return yield* getSourceProposedPlanReferenceForPendingTurnStart(threadId);
  });

  const markSourceProposedPlanImplemented = Effect.fn("markSourceProposedPlanImplemented")(
    function* (
      sourceThreadId: ThreadId,
      sourcePlanId: OrchestrationProposedPlanId,
      implementationThreadId: ThreadId,
      implementedAt: string,
    ) {
      const sourceThread = yield* resolveThreadDetail(sourceThreadId);
      const sourcePlan = sourceThread?.proposedPlans.find((entry) => entry.id === sourcePlanId);
      if (!sourceThread || !sourcePlan || sourcePlan.implementedAt !== null) {
        return;
      }

      const commandUuid = yield* crypto.randomUUIDv4;
      yield* orchestrationEngine.dispatch({
        type: "thread.proposed-plan.upsert",
        commandId: CommandId.make(
          `provider:source-proposed-plan-implemented:${implementationThreadId}:${commandUuid}`,
        ),
        threadId: sourceThread.id,
        proposedPlan: {
          ...sourcePlan,
          implementedAt,
          implementationThreadId,
          updatedAt: implementedAt,
        },
        createdAt: implementedAt,
      });
    },
  );

  const processRuntimeEvent = (event: ProviderRuntimeEvent) =>
    Effect.gen(function* () {
      const now = event.createdAt;

      if (event.type === "account.rate-limits.updated") {
        const usageLimits = buildUsageLimitsSnapshot(event);
        if (!usageLimits) return;
        yield* orchestrationEngine.dispatch({
          type: "provider.usage-limits.update",
          commandId: yield* providerCommandId(event, "provider-usage-limits-update"),
          provider: event.provider,
          providerInstanceId:
            event.providerInstanceId ?? defaultInstanceIdForDriver(event.provider),
          usageLimits,
          createdAt: now,
        });
        return;
      }

      if (isSubagentRuntimeEvent(event)) {
        const threadId = ThreadId.make(event.threadId);
        yield* updateSubagentActivity({ event, threadId });
        yield* appendActivities(
          event,
          threadId,
          runtimeEventToActivities(event).filter((activity) =>
            SUBAGENT_STANDALONE_ACTIVITY_KINDS.has(activity.kind),
          ),
        );
        return;
      }

      const thread = yield* resolveThreadShell(event.threadId);
      if (!thread) return;

      let loadedThreadDetail: OrchestrationThread | null | undefined;
      const getLoadedThreadDetail = () =>
        Effect.gen(function* () {
          if (loadedThreadDetail !== undefined) {
            return loadedThreadDetail;
          }
          loadedThreadDetail = (yield* resolveThreadDetail(thread.id)) ?? null;
          return loadedThreadDetail;
        });

      const eventTurnId = toTurnId(event.turnId);
      const activeTurnId = thread.session?.activeTurnId ?? null;
      const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByThreadId({
        threadId: thread.id,
      });
      const hasPendingTurnStart =
        Option.isSome(pendingTurnStart) && thread.session?.status === "starting";

      if (event.type === "turn.completed") {
        yield* flushSubagentActivities({
          threadId: thread.id,
          ...(eventTurnId ? { turnId: eventTurnId } : {}),
          terminalStatus:
            normalizeRuntimeTurnState(event.payload.state) === "completed" ? "completed" : "failed",
          event,
          clear: true,
        });
      } else if (event.type === "turn.aborted" || event.type === "runtime.error") {
        yield* flushSubagentActivities({
          threadId: thread.id,
          ...(eventTurnId ? { turnId: eventTurnId } : {}),
          terminalStatus: "failed",
          event,
          clear: true,
        });
      } else if (event.type === "session.exited") {
        yield* flushSubagentActivities({
          threadId: thread.id,
          terminalStatus: "failed",
          event,
          clear: true,
        });
      }

      const conflictsWithActiveTurn =
        activeTurnId !== null && eventTurnId !== undefined && !sameId(activeTurnId, eventTurnId);
      const missingTurnForActiveTurn = activeTurnId !== null && eventTurnId === undefined;
      const isTerminalTurnEvent = event.type === "turn.completed" || event.type === "turn.aborted";
      const terminatesAssistantTurn =
        isTerminalTurnEvent || event.type === "runtime.error" || event.type === "session.exited";

      // A turn.started that conflicts with the active turn is legitimate when
      // the server itself has a turn start pending for this thread AND the
      // provider session already tracks the event's turn as its active turn:
      // steering a running turn makes some providers (e.g. opencode) open a
      // new turn without ever completing the superseded one. A stale
      // turn.started for some other turn id still gets rejected.
      const conflictingTurnStartIsPendingTurnStart =
        event.type === "turn.started" && conflictsWithActiveTurn
          ? sameId(yield* getExpectedProviderTurnIdForThread(thread.id), eventTurnId) &&
            Option.isSome(pendingTurnStart)
          : false;

      const shouldApplyThreadLifecycle = (() => {
        if (!STRICT_PROVIDER_LIFECYCLE_GUARD) {
          return true;
        }
        switch (event.type) {
          case "session.exited":
            return true;
          case "session.started":
          case "thread.started":
            return true;
          case "turn.started":
            return !conflictsWithActiveTurn || conflictingTurnStartIsPendingTurnStart;
          case "turn.completed":
          case "turn.aborted":
            if (conflictsWithActiveTurn || missingTurnForActiveTurn) {
              return false;
            }
            // Only the active turn may close the lifecycle state.
            if (activeTurnId !== null && eventTurnId !== undefined) {
              return sameId(activeTurnId, eventTurnId);
            }
            // If no active turn is tracked, accept completion scoped to this thread.
            return true;
          default:
            return true;
        }
      })();
      const acceptedTurnStartedSourcePlan =
        event.type === "turn.started" && shouldApplyThreadLifecycle
          ? yield* getSourceProposedPlanReferenceForAcceptedTurnStart(thread.id, eventTurnId)
          : null;

      if (
        event.type === "session.started" ||
        event.type === "session.state.changed" ||
        event.type === "session.exited" ||
        event.type === "thread.started" ||
        event.type === "turn.started" ||
        isTerminalTurnEvent
      ) {
        const status = (() => {
          switch (event.type) {
            case "session.state.changed": {
              const runtimeStatus = orchestrationSessionStatusFromRuntimeState(event.payload.state);
              return hasPendingTurnStart && runtimeStatus === "ready" ? "starting" : runtimeStatus;
            }
            case "turn.started":
              return "running";
            case "session.exited":
              return "stopped";
            case "turn.completed":
              switch (normalizeRuntimeTurnState(event.payload.state)) {
                case "failed":
                  return "error";
                case "interrupted":
                case "cancelled":
                  return "interrupted";
                case "completed":
                  return "ready";
              }
            case "turn.aborted":
              return "interrupted";
            case "session.started":
            case "thread.started":
              // Provider thread/session start notifications can arrive during an
              // active or pending turn; preserve that lifecycle state.
              return activeTurnId !== null ? "running" : hasPendingTurnStart ? "starting" : "ready";
          }
        })();
        const nextActiveTurnId =
          event.type === "turn.started"
            ? (eventTurnId ?? null)
            : event.type === "turn.completed" ||
                event.type === "turn.aborted" ||
                event.type === "session.exited"
              ? null
              : event.type === "session.state.changed" &&
                  !sessionStatusAllowsActiveTurn(
                    orchestrationSessionStatusFromRuntimeState(event.payload.state),
                  )
                ? null
                : activeTurnId;
        const lastError =
          event.type === "session.state.changed" && event.payload.state === "error"
            ? (event.payload.reason ?? thread.session?.lastError ?? "Provider session error")
            : event.type === "turn.completed" &&
                normalizeRuntimeTurnState(event.payload.state) === "failed"
              ? (event.payload.errorMessage ?? thread.session?.lastError ?? "Turn failed")
              : event.type === "turn.aborted"
                ? (event.payload.reason ?? thread.session?.lastError ?? "Turn interrupted")
                : status === "ready"
                  ? null
                  : (thread.session?.lastError ?? null);

        if (shouldApplyThreadLifecycle) {
          if (event.type === "turn.started" && acceptedTurnStartedSourcePlan !== null) {
            yield* markSourceProposedPlanImplemented(
              acceptedTurnStartedSourcePlan.sourceThreadId,
              acceptedTurnStartedSourcePlan.sourcePlanId,
              thread.id,
              now,
            ).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning(
                  "provider runtime ingestion failed to mark source proposed plan",
                  {
                    eventId: event.eventId,
                    eventType: event.type,
                    cause: Cause.pretty(cause),
                  },
                ),
              ),
            );
          }

          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: yield* providerCommandId(event, "thread-session-set"),
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status,
              providerName: event.provider,
              ...(event.providerInstanceId !== undefined
                ? { providerInstanceId: event.providerInstanceId }
                : {}),
              runtimeMode: thread.session?.runtimeMode ?? "full-access",
              activeTurnId: nextActiveTurnId,
              lastError,
              updatedAt: now,
            },
            createdAt: now,
          });
        }
      }

      const assistantDelta =
        event.type === "content.delta" && event.payload.streamKind === "assistant_text"
          ? event.payload.delta
          : undefined;
      const proposedPlanDelta =
        event.type === "turn.proposed.delta" ? event.payload.delta : undefined;

      if (assistantDelta && assistantDelta.length > 0) {
        const turnId = toTurnId(event.turnId);
        const replayMessageId = assistantSegmentMessageId(
          assistantSegmentBaseKeyFromEvent(event),
          0,
        );
        const detailedMessages = (yield* getLoadedThreadDetail())?.messages ?? [];
        const recoveryScopeKey = transcriptItemScopeKey(event);
        const isRecoveringTranscriptItem =
          recoveryScopeKey !== null &&
          recoveringTranscriptJournalCountByScope.has(recoveryScopeKey);
        const segmentPrefix = `${replayMessageId}:segment:`;
        const projectedSegments = detailedMessages.filter(
          (message) =>
            message.id === replayMessageId || String(message.id).startsWith(segmentPrefix),
        );
        if (isRecoveringTranscriptItem && projectedSegments.length > 0 && turnId !== undefined) {
          const existingSegmentState = yield* getAssistantSegmentStateForTurn(thread.id, turnId);
          if (Option.isNone(existingSegmentState)) {
            const streamingSegment = projectedSegments.find((message) => message.streaming);
            const nextSegmentIndex = projectedSegments.length;
            yield* setAssistantSegmentStateForTurn(thread.id, turnId, {
              baseKey: assistantSegmentBaseKeyFromEvent(event),
              nextSegmentIndex:
                streamingSegment === undefined ? nextSegmentIndex + 1 : nextSegmentIndex,
              activeMessageId:
                streamingSegment?.id ??
                assistantSegmentMessageId(
                  assistantSegmentBaseKeyFromEvent(event),
                  nextSegmentIndex,
                ),
            });
          }
        }
        const assistantMessageId = yield* getOrCreateAssistantMessageId({
          threadId: thread.id,
          event,
          ...(turnId ? { turnId } : {}),
        });
        if (turnId) {
          yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
        }

        const authoritativeTranscriptRecovery =
          yield* readAuthoritativeTranscriptRecoveryCapability(event);
        const assistantDeliveryMode: AssistantDeliveryMode = authoritativeTranscriptRecovery
          ? yield* Effect.map(serverSettingsService.getSettings, (settings) =>
              settings.enableAssistantStreaming ? "streaming" : "buffered",
            )
          : "streaming";
        if (assistantDeliveryMode === "buffered") {
          for (const sourceEvent of journalSourceEvents(event)) {
            rememberBufferedAssistantJournalEvent(assistantMessageId, sourceEvent);
          }
          const spillChunk = yield* appendBufferedAssistantText(assistantMessageId, assistantDelta);
          if (spillChunk.length > 0) {
            yield* orchestrationEngine.dispatch({
              type: "thread.message.assistant.delta",
              commandId: yield* providerCommandId(event, "assistant-delta-buffer-spill"),
              threadId: thread.id,
              messageId: assistantMessageId,
              delta: spillChunk,
              ...(turnId ? { turnId } : {}),
              createdAt: now,
            });
            markParentJournalEventsDurable(
              event,
              takeBufferedAssistantJournalEvents(assistantMessageId),
            );
          }
        } else {
          yield* orchestrationEngine.dispatch({
            type: "thread.message.assistant.delta",
            commandId: yield* providerCommandId(event, "assistant-delta"),
            threadId: thread.id,
            messageId: assistantMessageId,
            delta: assistantDelta,
            ...(turnId ? { turnId } : {}),
            createdAt: now,
          });
          markParentJournalEventsDurable(event, journalSourceEvents(event));
        }
      }

      const pauseForUserTurnId =
        event.type === "request.opened" || event.type === "user-input.requested"
          ? toTurnId(event.turnId)
          : undefined;
      if (pauseForUserTurnId) {
        const detailedThread = yield* getLoadedThreadDetail();
        const assistantDeliveryMode: AssistantDeliveryMode = yield* Effect.map(
          serverSettingsService.getSettings,
          (settings) => (settings.enableAssistantStreaming ? "streaming" : "buffered"),
        );
        const flushedMessageIds =
          assistantDeliveryMode === "buffered"
            ? yield* flushBufferedAssistantMessagesForTurn({
                event,
                threadId: thread.id,
                turnId: pauseForUserTurnId,
                createdAt: now,
                commandTag:
                  event.type === "request.opened"
                    ? "assistant-delta-flush-on-request-opened"
                    : "assistant-delta-flush-on-user-input-requested",
              })
            : new Set<MessageId>();
        yield* finalizeActiveAssistantSegmentForTurn({
          event,
          threadId: thread.id,
          turnId: pauseForUserTurnId,
          createdAt: now,
          commandTag:
            event.type === "request.opened"
              ? "assistant-complete-on-request-opened"
              : "assistant-complete-on-user-input-requested",
          finalDeltaCommandTag:
            event.type === "request.opened"
              ? "assistant-delta-finalize-on-request-opened"
              : "assistant-delta-finalize-on-user-input-requested",
          hasProjectedMessage:
            detailedThread !== null &&
            hasAssistantMessageForTurn(detailedThread.messages, pauseForUserTurnId, {
              streamingOnly: true,
            }),
          flushedMessageIds,
        });
      }

      if (proposedPlanDelta && proposedPlanDelta.length > 0) {
        const planId = proposedPlanIdFromEvent(event, thread.id);
        yield* appendBufferedProposedPlan(planId, proposedPlanDelta, now);
      }

      const assistantCompletion =
        event.type === "item.completed" && event.payload.itemType === "assistant_message"
          ? {
              messageId: MessageId.make(
                `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
              ),
              fallbackText: event.payload.detail,
            }
          : undefined;
      const proposedPlanCompletion =
        event.type === "turn.proposed.completed"
          ? {
              planId: proposedPlanIdFromEvent(event, thread.id),
              turnId: toTurnId(event.turnId),
              planMarkdown: event.payload.planMarkdown,
            }
          : undefined;

      if (assistantCompletion) {
        const detailedThread = yield* getLoadedThreadDetail();
        const messages = detailedThread?.messages ?? [];
        const turnId = toTurnId(event.turnId);
        const activeAssistantMessageId = turnId
          ? yield* getActiveAssistantMessageIdForTurn(thread.id, turnId)
          : Option.none<MessageId>();
        const hasAssistantMessagesForTurn =
          turnId !== undefined ? hasAssistantMessageForTurn(messages, turnId) : false;
        const assistantMessageId = Option.getOrElse(
          activeAssistantMessageId,
          () => assistantCompletion.messageId,
        );
        const existingAssistantMessage = findMessageById(messages, assistantMessageId);
        const shouldApplyFallbackCompletionText =
          !existingAssistantMessage || existingAssistantMessage.text.length === 0;

        const shouldSkipRedundantCompletion =
          Option.isNone(activeAssistantMessageId) &&
          turnId !== undefined &&
          hasAssistantMessagesForTurn &&
          (assistantCompletion.fallbackText?.trim().length ?? 0) === 0;

        if (!shouldSkipRedundantCompletion) {
          if (turnId && Option.isNone(activeAssistantMessageId)) {
            yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
          }

          yield* finalizeAssistantMessage({
            event,
            threadId: thread.id,
            messageId: assistantMessageId,
            ...(turnId ? { turnId } : {}),
            createdAt: now,
            commandTag: "assistant-complete",
            finalDeltaCommandTag: "assistant-delta-finalize",
            hasProjectedMessage: existingAssistantMessage !== undefined,
            ...(assistantCompletion.fallbackText !== undefined && shouldApplyFallbackCompletionText
              ? { fallbackText: assistantCompletion.fallbackText }
              : {}),
          });

          if (turnId) {
            yield* forgetAssistantMessageId(thread.id, turnId, assistantMessageId);
          }
        }

        if (turnId) {
          yield* clearAssistantSegmentStateForTurn(thread.id, turnId);
        }
      }

      if (proposedPlanCompletion) {
        const detailedThread = yield* getLoadedThreadDetail();
        yield* finalizeBufferedProposedPlan({
          event,
          threadId: thread.id,
          threadProposedPlans: detailedThread?.proposedPlans ?? [],
          planId: proposedPlanCompletion.planId,
          ...(proposedPlanCompletion.turnId ? { turnId: proposedPlanCompletion.turnId } : {}),
          fallbackMarkdown: proposedPlanCompletion.planMarkdown,
          updatedAt: now,
        });
      }

      if (terminatesAssistantTurn) {
        const detailedThread = yield* getLoadedThreadDetail();
        const messages = detailedThread?.messages ?? [];
        const proposedPlans = detailedThread?.proposedPlans ?? [];
        const turnId = eventTurnId ?? activeTurnId ?? undefined;
        if (turnId) {
          const assistantMessageIds = yield* getAssistantMessageIdsForTurn(thread.id, turnId);
          yield* Effect.forEach(
            assistantMessageIds,
            (assistantMessageId) =>
              finalizeAssistantMessage({
                event,
                threadId: thread.id,
                messageId: assistantMessageId,
                turnId,
                createdAt: now,
                commandTag: "assistant-complete-finalize",
                finalDeltaCommandTag: "assistant-delta-finalize-fallback",
                hasProjectedMessage: findMessageById(messages, assistantMessageId) !== undefined,
              }),
            { concurrency: 1 },
          ).pipe(Effect.asVoid);
          yield* clearAssistantMessageIdsForTurn(thread.id, turnId);
          yield* clearAssistantSegmentStateForTurn(thread.id, turnId);

          yield* finalizeBufferedProposedPlan({
            event,
            threadId: thread.id,
            threadProposedPlans: proposedPlans,
            planId: proposedPlanIdForTurn(thread.id, turnId),
            turnId,
            updatedAt: now,
          });
        }

        if (
          shouldApplyThreadLifecycle &&
          event.type === "turn.completed" &&
          normalizeRuntimeTurnState(event.payload.state) === "completed"
        ) {
          const queuedMessage = detailedThread?.queuedMessages?.[0];
          if (queuedMessage) {
            yield* orchestrationEngine.dispatch({
              type: "thread.queued-message.dispatch",
              commandId: yield* providerCommandId(event, "queued-message-dispatch"),
              threadId: thread.id,
              messageId: queuedMessage.messageId,
              createdAt: now,
            });
          }
        }
      }

      if (event.type === "session.exited") {
        yield* clearTurnStateForSession(thread.id);
      }

      if (event.type === "runtime.error") {
        const runtimeErrorMessage = event.payload.message;

        const shouldApplyRuntimeError = !STRICT_PROVIDER_LIFECYCLE_GUARD
          ? true
          : activeTurnId === null || eventTurnId === undefined || sameId(activeTurnId, eventTurnId);

        if (shouldApplyRuntimeError) {
          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: yield* providerCommandId(event, "runtime-error-session-set"),
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status: "error",
              providerName: event.provider,
              ...(event.providerInstanceId !== undefined
                ? { providerInstanceId: event.providerInstanceId }
                : {}),
              runtimeMode: thread.session?.runtimeMode ?? "full-access",
              activeTurnId: eventTurnId ?? null,
              lastError: runtimeErrorMessage,
              updatedAt: now,
            },
            createdAt: now,
          });
        }
      }

      if (event.type === "thread.metadata.updated" && event.payload.name) {
        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: yield* providerCommandId(event, "thread-meta-update"),
          threadId: thread.id,
          title: event.payload.name,
        });
      }

      if (event.type === "turn.diff.updated") {
        const turnId = toTurnId(event.turnId);
        const checkpointContext = turnId
          ? yield* projectionSnapshotQuery
              .getThreadCheckpointContext(thread.id)
              .pipe(Effect.map(Option.getOrUndefined))
          : undefined;
        const workspaceCwd =
          checkpointContext?.worktreePath ?? checkpointContext?.workspaceRoot ?? undefined;
        if (turnId && checkpointContext && workspaceCwd && isGitRepository(workspaceCwd)) {
          // Skip if a checkpoint already exists for this turn. A real
          // (non-placeholder) capture from CheckpointReactor should not
          // be clobbered, and dispatching a duplicate placeholder for the
          // same turnId would produce an unstable checkpointTurnCount.
          if (hasCheckpointForTurn(checkpointContext.checkpoints, turnId)) {
            // Already tracked; no-op.
          } else {
            const assistantMessageId = MessageId.make(
              `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
            );
            yield* orchestrationEngine.dispatch({
              type: "thread.turn.diff.complete",
              commandId: yield* providerCommandId(event, "thread-turn-diff-complete"),
              threadId: thread.id,
              turnId,
              completedAt: now,
              checkpointRef: CheckpointRef.make(`provider-diff:${event.eventId}`),
              status: "missing",
              files: [],
              assistantMessageId,
              checkpointTurnCount: maxCheckpointTurnCount(checkpointContext.checkpoints) + 1,
              createdAt: now,
            });
          }
        }
      }

      if (event.type === "task.started" || event.type === "task.progress") {
        const description = event.payload.description?.trim();
        if (description) {
          yield* rememberTaskDescription(thread.id, event.payload.taskId, description);
        }
      }
      // Sidebar background liveness: fed from the same lifecycle stream,
      // read by the shell query at mapping time (no persistence).
      switch (event.type) {
        case "task.started":
        case "task.progress":
        case "task.updated":
        case "task.completed": {
          const payload = event.payload as {
            taskId: string;
            taskType?: string;
            status?: string;
            agentId?: string;
          };
          threadBackgroundLiveness.recordTaskLiveness({
            threadId: thread.id,
            taskId: payload.taskId,
            taskType: payload.taskType,
            status: payload.status,
            agentId: payload.agentId,
            kind:
              event.type === "task.started"
                ? "started"
                : event.type === "task.progress"
                  ? "progress"
                  : event.type === "task.updated"
                    ? "updated"
                    : "completed",
          });
          break;
        }
        case "session.exited":
          threadBackgroundLiveness.clearThreadLiveness(thread.id);
          break;
        default:
          break;
      }

      let taskTitle: string | undefined;
      if (event.type === "task.completed") {
        taskTitle = yield* lookupTaskDescription(thread.id, event.payload.taskId);
        if (!taskTitle) {
          const threadDetail = yield* getLoadedThreadDetail();
          taskTitle = findTaskTitleInActivities(threadDetail?.activities, event.payload.taskId);
        }
      }

      const activities = runtimeEventToActivities(event, taskTitle);
      yield* Effect.forEach(activities, (activity) =>
        providerCommandId(event, "thread-activity-append").pipe(
          Effect.flatMap((commandId) =>
            orchestrationEngine.dispatch({
              type: "thread.activity.append",
              commandId,
              threadId: thread.id,
              activity,
              createdAt: activity.createdAt,
            }),
          ),
        ),
      ).pipe(Effect.asVoid);
    });

  const processDomainEvent = (_event: TurnStartRequestedDomainEvent) => Effect.void;

  const processInput = (input: RuntimeIngestionInput) => {
    if (input.source === "domain") {
      return processDomainEvent(input.event);
    }
    incrementWorkloadCounter("provider.events.received");
    if (input.event.type === "content.delta") {
      incrementWorkloadCounter("provider.delta.chunks");
      incrementWorkloadCounter(
        "provider.delta.characters",
        typeof input.event.payload.delta === "string" ? input.event.payload.delta.length : 0,
      );
    }
    if (hasProcessedRuntimeEvent(input.event)) {
      incrementWorkloadCounter("provider.events.duplicates_suppressed");
      return Effect.void;
    }
    if (
      isSubagentRuntimeEvent(input.event) &&
      input.event.type === "content.delta" &&
      input.event.payload.streamKind === "command_output"
    ) {
      incrementWorkloadCounter("ingestion.activity.candidates");
      incrementWorkloadCounter("ingestion.activity.unchanged_suppressed");
      // Command-output chunks carry no semantic state. Replaying one is the
      // same no-op, so retaining thousands of identities would only amplify
      // memory with provider chunk cardinality.
      return Effect.void;
    }
    return processRuntimeEvent(input.event).pipe(
      Effect.andThen(rememberProcessedRuntimeEvent(input.event)),
    );
  };

  const retryPersistence = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.retry({
        schedule: Schedule.spaced("50 millis"),
        while: (error) => {
          if (!isPersistenceError(error)) return false;
          incrementWorkloadCounter("ingestion.activity.persistence_retries");
          return true;
        },
      }),
    );

  const removePromotedJournalEvent = (event: ProviderRuntimeEvent) => {
    if (!isTranscriptDurabilityEvent(event)) return Effect.void;
    if (isSubagentRuntimeEvent(event)) {
      if (event.type === "item.completed" && event.payload.itemType === "assistant_message") {
        return retryPersistence(transcriptJournal.markItemCompleted(event)).pipe(
          Effect.andThen(retryPersistence(transcriptJournal.removeItem(event))),
        );
      }
      return retryPersistence(transcriptJournal.remove(event));
    }
    const promotedEvents = durableParentDeltaPromotions.get(String(event.eventId)) ?? [];
    durableParentDeltaPromotions.delete(String(event.eventId));
    const removePromotedEvents = retryPersistence(transcriptJournal.removeMany(promotedEvents));
    if (event.type === "item.completed" && event.payload.itemType === "assistant_message") {
      return removePromotedEvents.pipe(
        Effect.andThen(retryPersistence(transcriptJournal.markItemCompleted(event))),
        Effect.andThen(retryPersistence(transcriptJournal.removeItem(event))),
        Effect.tap(() =>
          Effect.sync(() => {
            const scopeKey = transcriptItemScopeKey(event);
            if (scopeKey !== null) recoveringTranscriptJournalCountByScope.delete(scopeKey);
          }),
        ),
      );
    }
    if (event.type === "content.delta" && event.payload.streamKind === "assistant_text") {
      return removePromotedEvents;
    }
    // Lifecycle rows are removed only by their own identity. Never sweep a
    // turn/thread by acceptance sequence: an earlier journaled event may not
    // have reached its volatile delivery queue yet.
    return removePromotedEvents.pipe(
      Effect.andThen(retryPersistence(transcriptJournal.remove(event))),
    );
  };

  const processJournaledRuntimeEvent = (
    batch: ProviderTranscriptJournalBatch,
    phase: TranscriptJournalIngestionPhase,
  ) => {
    const { event, sourceEvents } = batch;
    return Effect.gen(function* () {
      if (sourceEvents.length > 1) {
        journalBatchSourcesByEventId.set(String(event.eventId), sourceEvents);
      }
      if (
        event.itemId !== undefined &&
        (event.type === "content.delta" ||
          (event.type === "item.completed" && event.payload.itemType === "assistant_message")) &&
        (yield* retryPersistence(transcriptJournal.isItemCompleted(event)))
      ) {
        incrementWorkloadCounter("provider.events.duplicates_suppressed");
        yield* retryPersistence(transcriptJournal.removeMany(sourceEvents));
        return;
      }
      yield* retryPersistence(processInput({ source: "runtime", event }));
      yield* Effect.forEach(sourceEvents.slice(1), rememberProcessedRuntimeEvent, {
        concurrency: 1,
        discard: true,
      });
      yield* retryPersistence(transcriptJournal.markDeliveredMany(sourceEvents));
      yield* removePromotedJournalEvent(event);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => journalBatchSourcesByEventId.delete(String(event.eventId))),
      ),
      (effect) =>
        observeTranscriptJournalBatch({
          tracker: transcriptJournalTracker,
          phase,
          batch,
          effect,
        }),
    );
  };

  const drainPendingTranscriptJournal = (fallbackEvent?: ProviderRuntimeEvent) =>
    Effect.gen(function* () {
      let pending = yield* retryPersistence(transcriptJournal.listUndelivered);
      if (
        fallbackEvent !== undefined &&
        isBatchableParentAssistantDelta(fallbackEvent) &&
        pending.some(({ event }) => event.eventId === fallbackEvent.eventId)
      ) {
        // One frame is short enough to remain visually live while allowing the
        // adapter's token burst to reach the durable journal before projection.
        yield* Effect.sleep("16 millis");
        pending = yield* retryPersistence(transcriptJournal.listUndelivered);
      }
      // Merge rows observed from SQLite rather than replacing tracker state:
      // an accepted append can race this read and must remain authoritative.
      yield* transcriptJournalTracker.registerEntries(pending);
      let fallbackWasJournaled = false;
      const relevantPending =
        fallbackEvent === undefined
          ? pending
          : pending.filter(({ event }) => event.threadId === fallbackEvent.threadId);
      for (const batch of batchProviderTranscriptJournalEntries(relevantPending)) {
        if (fallbackEvent !== undefined) {
          fallbackWasJournaled ||= batch.sourceEvents.some(
            (event) =>
              event.eventId === fallbackEvent.eventId &&
              (event.providerInstanceId ?? defaultInstanceIdForDriver(event.provider)) ===
                (fallbackEvent.providerInstanceId ??
                  defaultInstanceIdForDriver(fallbackEvent.provider)),
          );
        }
        yield* processJournaledRuntimeEvent(batch, "live");
      }
      // Unit/mocked provider services may bypass the adapter acceptance seam.
      // Production semantic events are always found in the journal.
      if (
        fallbackEvent !== undefined &&
        !fallbackWasJournaled &&
        !hasProcessedRuntimeEvent(fallbackEvent)
      ) {
        yield* processJournaledRuntimeEvent(
          {
            event: fallbackEvent,
            sourceEvents: [fallbackEvent],
          },
          "live",
        );
      }
    });

  const processInputSafely = (input: RuntimeIngestionInput) =>
    (input.source === "runtime" && isTranscriptDurabilityEvent(input.event)
      ? drainPendingTranscriptJournal(input.event)
      : processInput(input)
    ).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider runtime ingestion failed to process event", {
          source: input.source,
          eventId: input.event.eventId,
          eventType: input.event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeKeyedDrainableWorker({
    concurrency: 8,
    process: (input: RuntimeIngestionInput, _threadId: ThreadId) => processInputSafely(input),
  });
  const drain = worker.drain.pipe(
    Effect.andThen(
      flushSubagentActivities().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider runtime ingestion failed to flush subagent activities", {
            cause: Cause.pretty(cause),
          }),
        ),
      ),
    ),
  );
  const finalize = worker.drain.pipe(
    Effect.andThen(
      flushSubagentActivities({ clear: true }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider runtime ingestion failed to finalize subagent activities", {
            cause: Cause.pretty(cause),
          }),
        ),
      ),
    ),
    Effect.ensuring(
      Effect.sync(() => {
        adjustWorkloadGauge("ingestion.subagent_coalescers.active", -subagentStates.size);
        subagentStates.clear();
        let retainedEventCount = 0;
        for (const state of processedRuntimeEventsBySession.values()) {
          for (const eventIds of state.activeEventIdsByScope.values()) {
            retainedEventCount += eventIds.size;
          }
        }
        adjustWorkloadGauge("ingestion.dedupe.events.active", -retainedEventCount);
        processedRuntimeEventsBySession.clear();
        recoveringTranscriptJournalCountByScope.clear();
        durableParentDeltaPromotions.clear();
        journalBatchSourcesByEventId.clear();
        bufferedAssistantJournalEventsByMessageId.clear();
      }),
    ),
    Effect.ensuring(transcriptJournalTracker.reset),
  );

  const start: ProviderRuntimeIngestionShape["start"] = () =>
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() => finalize.pipe(Effect.ignore));
      const liveSubscription =
        providerService.subscribeEvents === undefined
          ? null
          : yield* providerService.subscribeEvents;
      const pendingTranscriptEvents = yield* retryPersistence(transcriptJournal.list).pipe(
        Effect.orDie,
      );
      const initialUndeliveredTranscriptEvents = yield* retryPersistence(
        transcriptJournal.listUndelivered,
      ).pipe(Effect.orDie);
      yield* transcriptJournalTracker.hydrateOnce(initialUndeliveredTranscriptEvents);
      for (const { event } of pendingTranscriptEvents) {
        const scopeKey = transcriptItemScopeKey(event);
        if (scopeKey === null) continue;
        if (event.type === "content.delta" && event.payload.streamKind === "assistant_text") {
          recoveringTranscriptJournalCountByScope.set(
            scopeKey,
            (recoveringTranscriptJournalCountByScope.get(scopeKey) ?? 0) + 1,
          );
        }
      }
      const recoveryBatches = batchProviderTranscriptJournalEntries(pendingTranscriptEvents);
      yield* transcriptJournalTracker.beginRecovery({
        batchCount: recoveryBatches.length,
        sourceEventCount: pendingTranscriptEvents.length,
      });
      yield* Effect.forEach(
        recoveryBatches,
        (batch) =>
          processJournaledRuntimeEvent(batch, "recovery").pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                const { event, sourceEvents } = batch;
                const scopeKey = transcriptItemScopeKey(event);
                if (scopeKey === null) return;
                const remaining = recoveringTranscriptJournalCountByScope.get(scopeKey);
                if (remaining === undefined) return;
                if (remaining > sourceEvents.length) {
                  recoveringTranscriptJournalCountByScope.set(
                    scopeKey,
                    remaining - sourceEvents.length,
                  );
                  return;
                }
                recoveringTranscriptJournalCountByScope.delete(scopeKey);
              }),
            ),
            // Batch outcomes (including a bounded sample of failed identities)
            // are aggregated into the single recovery summary log.
            Effect.catchCause(() => Effect.void),
          ),
        { concurrency: 1, discard: true },
      ).pipe(Effect.ensuring(transcriptJournalTracker.finishRecovery));
      yield* forkParked(
        Stream.runForEach(
          liveSubscription === null
            ? providerService.streamEvents
            : Stream.fromSubscription(liveSubscription),
          (event) => worker.enqueue(event.threadId, { source: "runtime", event }),
        ),
      );
      yield* forkParked(
        Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
          if (event.type !== "thread.turn-start-requested") {
            return Effect.void;
          }
          return worker.enqueue(event.payload.threadId, { source: "domain", event });
        }),
      );
    });

  return {
    start,
    drain,
  } satisfies ProviderRuntimeIngestionShape;
});

export const ProviderRuntimeIngestionLive = Layer.effect(
  ProviderRuntimeIngestionService,
  make,
).pipe(
  Layer.provide(
    Layer.mergeAll(
      ProjectionTurnRepositoryLive,
      OrchestrationCommandReceiptRepositoryLive,
      ProviderTranscriptJournalLive,
    ),
  ),
);
