import { IdAllocatorV2, layer as idAllocatorLayer } from "./IdAllocator.ts";
import { ProviderDriverKind, type OrchestrationV2ProviderThread } from "@t3tools/contracts";
import {
  ThreadWorkspaceId,
  ThreadSkillScope,
  OrchestrationNotificationOrigin,
} from "@t3tools/contracts";
import {
  ChatAttachment,
  DEFAULT_MODEL,
  EventId,
  MessageId,
  ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  OrchestrationV2AppThreadJson,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2TurnItem,
  PlanId,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  ThreadLinkedPullRequest,
  TurnItemId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { EventSinkV2 } from "./EventSink.ts";
import { EventStoreV2 } from "./EventStore.ts";
import { makeKeyedSerialExecutor } from "./KeyedSerialExecutor.ts";

const IMPORT_EVENT_PREFIX = "migration:v1";
const TRANSCRIPT_EVENT_BATCH_SIZE = 100;

interface LegacyThreadRow {
  readonly thread_id: string;
  readonly project_id: string;
  readonly title: string;
  readonly model_selection_json: string | null;
  readonly runtime_mode: string;
  readonly interaction_mode: string;
  readonly branch: string | null;
  readonly worktree_path: string | null;
  readonly workspace_id: string | null;
  readonly title_mode: string | null;
  readonly skill_scope_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly archived_at: string | null;
  readonly settled_override: string | null;
  readonly settled_at: string | null;
  readonly unsettled_at: string | null;
  readonly snoozed_until: string | null;
  readonly snoozed_at: string | null;
  readonly pinned_at: string | null;
  readonly pin_order_key: string | null;
  readonly active_order_key: string | null;
  readonly linked_pull_request_json: string | null;
  readonly deleted_at: string | null;
}

interface LegacySessionRow {
  readonly provider_name: string;
  readonly provider_instance_id: string | null;
  readonly resume_cursor_json: string | null;
}

interface LegacyRepairRow extends LegacyThreadRow {
  readonly payload_json: string;
}

interface LegacyMessageRow {
  readonly message_id: string;
  readonly thread_id: string;
  readonly turn_id: string | null;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly attachments_json: string | null;
  readonly origin_json: string | null;
  readonly is_streaming: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly ordinal: number;
}

interface LegacyImportRow {
  readonly thread_id: string;
  readonly transcript_imported_at: string | null;
}

interface LegacyQueuedMessageRow {
  readonly message_id: string;
  readonly thread_id: string;
  readonly text: string;
  readonly attachments_json: string;
  readonly origin_json: string | null;
  readonly model_selection_json: string | null;
  readonly title_seed: string | null;
  readonly runtime_mode: string;
  readonly interaction_mode: string;
  readonly source_proposed_plan_thread_id: string | null;
  readonly source_proposed_plan_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface LegacyTurnRow {
  readonly row_id: number;
  readonly thread_id: string;
  readonly turn_id: string | null;
  readonly pending_message_id: string | null;
  readonly assistant_message_id: string | null;
  readonly state: string;
  readonly requested_at: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
}

export interface LegacyV1ImportSummary {
  readonly importedThreadCount: number;
  readonly importedMessageCount: number;
}

export class LegacyV1ThreadImportError extends Schema.TaggedErrorClass<LegacyV1ThreadImportError>()(
  "LegacyV1ThreadImportError",
  {
    operation: Schema.String,
    threadId: Schema.optional(ThreadId),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.threadId === undefined
      ? `Failed to ${this.operation} legacy v1 threads.`
      : `Failed to ${this.operation} legacy v1 thread ${this.threadId}.`;
  }
}

export interface LegacyV1ThreadImporterShape {
  readonly pendingThreadCount: Effect.Effect<number, LegacyV1ThreadImportError>;
  readonly reconcileShells: Effect.Effect<LegacyV1ImportSummary, LegacyV1ThreadImportError>;
  readonly ensureTranscript: (
    threadId: ThreadId,
  ) => Effect.Effect<LegacyV1ImportSummary, LegacyV1ThreadImportError>;
  readonly importPendingTranscripts: Effect.Effect<LegacyV1ImportSummary, never>;
}

export class LegacyV1ThreadImporter extends Context.Service<
  LegacyV1ThreadImporter,
  LegacyV1ThreadImporterShape
>()("t3/orchestration-v2/LegacyV1ThreadImporter") {}

const decodeModelSelection = Schema.decodeUnknownOption(ModelSelection);
const decodeAttachments = Schema.decodeUnknownOption(Schema.Array(ChatAttachment));
const decodeLinkedPullRequest = Schema.decodeUnknownOption(ThreadLinkedPullRequest);
const decodeLegacyResumeCursor = Schema.decodeUnknownOption(
  Schema.Struct({
    threadId: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))),
    sessionId: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))),
  }),
);
const decodeStoredThread = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestrationV2AppThreadJson),
);

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

function modelSelectionFor(row: LegacyThreadRow) {
  const decoded =
    row.model_selection_json === null
      ? Option.none()
      : decodeModelSelection(parseJson(row.model_selection_json));
  return Option.getOrElse(decoded, () => ({
    instanceId: ProviderInstanceId.make("codex"),
    model: DEFAULT_MODEL,
  }));
}

function modelSelectionFromJson(json: string | null, fallback: ModelSelection): ModelSelection {
  if (json === null) return fallback;
  return Option.getOrElse(decodeModelSelection(parseJson(json)), () => fallback);
}

function attachmentsFor(row: LegacyMessageRow) {
  if (row.attachments_json === null) return [];
  return Option.getOrElse(decodeAttachments(parseJson(row.attachments_json)), () => []);
}

function linkedPullRequestFor(row: LegacyThreadRow) {
  if (row.linked_pull_request_json === null) return null;
  return Option.getOrNull(decodeLinkedPullRequest(parseJson(row.linked_pull_request_json)));
}

function originFromJson(json: string | null) {
  if (json === null) return undefined;
  return Option.getOrUndefined(
    Schema.decodeUnknownOption(OrchestrationNotificationOrigin)(parseJson(json)),
  );
}

/**
 * Legacy provider sessions carried a provider kind, while queued rows only
 * carry an instance id. Keep the mapping conservative: known legacy aliases
 * resolve to their actual driver and an unknown custom instance remains an
 * unavailable driver instead of pretending the instance id is a driver id.
 */
function driverForLegacyProvider(
  providerName: string | null,
  providerInstanceId: ProviderInstanceId,
): ProviderDriverKind {
  const provider = providerName?.trim().toLowerCase();
  if (provider === "codex" || provider === "codex-cli") return ProviderDriverKind.make("codex");
  if (provider === "claude" || provider === "claudeagent" || provider === "claudex") {
    return ProviderDriverKind.make("claudeAgent");
  }
  if (provider === "opencode" || provider === "open-code") {
    return ProviderDriverKind.make("opencode");
  }
  if (provider === "cursor") return ProviderDriverKind.make("cursor");
  if (provider === "grok") return ProviderDriverKind.make("grok");

  const instance = providerInstanceId.toLowerCase();
  if (instance === "codex") return ProviderDriverKind.make("codex");
  if (instance === "claudex" || instance === "claude" || instance === "claudeagent") {
    return ProviderDriverKind.make("claudeAgent");
  }
  if (instance === "opencode") return ProviderDriverKind.make("opencode");
  if (instance === "cursor") return ProviderDriverKind.make("cursor");
  if (instance === "grok") return ProviderDriverKind.make("grok");
  return ProviderDriverKind.make("unknown");
}

function nativeIdForLegacySession(
  session: LegacySessionRow,
  providerInstanceId: ProviderInstanceId,
): string | undefined {
  if (session.resume_cursor_json === null) return undefined;
  const cursor = decodeLegacyResumeCursor(parseJson(session.resume_cursor_json));
  if (Option.isNone(cursor)) return undefined;

  const driver = driverForLegacyProvider(session.provider_name, providerInstanceId);
  const rawNativeId =
    driver === "cursor" || driver === "opencode" ? cursor.value.sessionId : cursor.value.threadId;
  if (rawNativeId === undefined || rawNativeId === null) return undefined;

  const nativeId = String(rawNativeId).trim();
  return nativeId === "" || nativeId === "0" ? undefined : nativeId;
}

function runtimeModeFor(value: string): OrchestrationV2AppThread["runtimeMode"] {
  return value === "approval-required" ||
    value === "auto-accept-edits" ||
    value === "auto" ||
    value === "full-access"
    ? value
    : "full-access";
}

function interactionModeFor(value: string): OrchestrationV2AppThread["interactionMode"] {
  return value === "plan" ? "plan" : "default";
}

function settledOverrideFor(value: string | null): OrchestrationV2AppThread["settledOverride"] {
  return value === "settled" || value === "active" ? value : null;
}

function dateTime(value: string): DateTime.Utc {
  return DateTime.makeUnsafe(value);
}

function nullableDateTime(value: string | null): DateTime.Utc | null {
  return value === null ? null : dateTime(value);
}

function importedThread(row: LegacyThreadRow): OrchestrationV2AppThread {
  const threadId = ThreadId.make(row.thread_id);
  const modelSelection = modelSelectionFor(row);
  const branch = row.branch?.trim() || null;
  const worktreePath = row.worktree_path?.trim() || null;
  return {
    createdBy: "system",
    creationSource: "server",
    id: threadId,
    projectId: ProjectId.make(row.project_id),
    title: row.title.trim() === "" ? "Untitled thread" : row.title,
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    runtimeMode: runtimeModeFor(row.runtime_mode),
    interactionMode: interactionModeFor(row.interaction_mode),
    branch,
    worktreePath,
    workspaceId: row.workspace_id === null ? null : ThreadWorkspaceId.make(row.workspace_id),
    ...(row.title_mode === "manual" || row.title_mode === "automatic"
      ? { titleMode: row.title_mode }
      : {}),
    ...(row.skill_scope_json === null
      ? {}
      : {
          skillScope: Schema.decodeUnknownSync(Schema.fromJsonString(ThreadSkillScope))(
            row.skill_scope_json,
          ),
        }),
    linkedPullRequest: linkedPullRequestFor(row),
    activeProviderThreadId: null,
    historyOrigin: "v1_import",
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    forkedFrom: null,
    createdAt: dateTime(row.created_at),
    updatedAt: dateTime(row.updated_at),
    archivedAt: nullableDateTime(row.archived_at),
    settledOverride: settledOverrideFor(row.settled_override),
    settledAt: nullableDateTime(row.settled_at),
    unsettledAt: nullableDateTime(row.unsettled_at),
    snoozedUntil: nullableDateTime(row.snoozed_until),
    snoozedAt: nullableDateTime(row.snoozed_at),
    pinnedAt: nullableDateTime(row.pinned_at),
    pinOrderKey: row.pin_order_key?.trim() || null,
    activeOrderKey: row.active_order_key?.trim() || null,
    lastVisitedAt: null,
    deletedAt: nullableDateTime(row.deleted_at),
  };
}

function messageEvents(row: LegacyMessageRow): ReadonlyArray<OrchestrationV2DomainEvent> {
  const threadId = ThreadId.make(row.thread_id);
  const messageId = MessageId.make(row.message_id);
  const createdAt = dateTime(row.created_at);
  const updatedAt = dateTime(row.updated_at);
  const attachments = attachmentsFor(row);
  const message: OrchestrationV2ConversationMessage = {
    createdBy: row.role === "user" ? "user" : "agent",
    creationSource: "server",
    id: messageId,
    threadId,
    runId: null,
    nodeId: null,
    role: row.role,
    text: row.text,
    attachments,
    ...(row.origin_json === null
      ? {}
      : {
          origin: Schema.decodeUnknownSync(Schema.fromJsonString(OrchestrationNotificationOrigin))(
            row.origin_json,
          ),
        }),
    streaming: false,
    createdAt,
    updatedAt,
  };
  const baseTurnItem = {
    id: TurnItemId.make(`${IMPORT_EVENT_PREFIX}:turn-item:${row.message_id}`),
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: row.ordinal,
    status: row.is_streaming === 1 ? ("interrupted" as const) : ("completed" as const),
    title: null,
    startedAt: createdAt,
    completedAt: updatedAt,
    updatedAt,
  };
  const turnItem: OrchestrationV2TurnItem =
    row.role === "user"
      ? {
          ...baseTurnItem,
          createdBy: "user",
          creationSource: "server",
          type: "user_message",
          messageId,
          inputIntent: "turn_start",
          text: row.text,
          attachments,
        }
      : {
          ...baseTurnItem,
          type: "assistant_message",
          messageId,
          text: row.text,
          streaming: false,
        };
  return [
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:message:${row.message_id}`),
      type: "message.updated",
      threadId,
      occurredAt: updatedAt,
      payload: message,
    },
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:turn-item:${row.message_id}`),
      type: "turn-item.updated",
      threadId,
      occurredAt: updatedAt,
      payload: turnItem,
    },
  ];
}

function legacyTerminalStatus(
  state: string,
): Extract<OrchestrationV2Run["status"], "completed" | "interrupted" | "failed"> {
  switch (state) {
    case "completed":
      return "completed";
    case "error":
      return "failed";
    // A v1 process can be killed while a row still says `running` or
    // `pending`; migration must leave that turn resumable by the user.
    case "interrupted":
    case "running":
    case "pending":
    default:
      return "interrupted";
  }
}

function terminalNodeStatus(
  status: Extract<OrchestrationV2Run["status"], "completed" | "interrupted" | "failed">,
): OrchestrationV2ExecutionNode["status"] {
  return status;
}

function legacyTurnMessageId(
  turn: LegacyTurnRow,
  messages: ReadonlyArray<LegacyMessageRow>,
): MessageId | null {
  if (turn.pending_message_id !== null && turn.pending_message_id.trim() !== "") {
    return MessageId.make(turn.pending_message_id);
  }
  if (turn.turn_id !== null) {
    const linked = messages.find(
      (message) =>
        message.role === "user" &&
        message.turn_id === turn.turn_id &&
        message.message_id.trim() !== "",
    );
    if (linked !== undefined) return MessageId.make(linked.message_id);
  }
  const latestUser = messages.find((message) => message.role === "user");
  return latestUser === undefined ? null : MessageId.make(latestUser.message_id);
}

function legacySourcePlanRef(row: LegacyQueuedMessageRow) {
  if (
    row.source_proposed_plan_thread_id === null ||
    row.source_proposed_plan_id === null ||
    row.source_proposed_plan_thread_id.trim() === "" ||
    row.source_proposed_plan_id.trim() === ""
  ) {
    return undefined;
  }
  return {
    threadId: ThreadId.make(row.source_proposed_plan_thread_id),
    planId: PlanId.make(row.source_proposed_plan_id),
  };
}

function chunks<A>(items: ReadonlyArray<A>, size: number): Array<ReadonlyArray<A>> {
  const result: Array<ReadonlyArray<A>> = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const ids = yield* IdAllocatorV2;
  const eventStore = yield* EventStoreV2;
  const eventSink = yield* EventSinkV2;
  const transcriptImports = yield* makeKeyedSerialExecutor<ThreadId>();

  const listMessages = (threadId: ThreadId) =>
    sql<LegacyMessageRow>`
      SELECT
        message_id,
        thread_id,
        turn_id,
        role,
        text,
        attachments_json,
        origin_json,
        is_streaming,
        created_at,
        updated_at,
        ROW_NUMBER() OVER (
          PARTITION BY thread_id
          ORDER BY created_at ASC, message_id ASC
        ) AS ordinal
      FROM projection_thread_messages
      WHERE thread_id = ${threadId}
        AND role IN ('user', 'assistant')
      ORDER BY created_at ASC, message_id ASC
    `;

  const listShellMessages = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const latest = yield* sql<LegacyMessageRow>`
        SELECT
          message.message_id,
          message.thread_id,
          message.turn_id,
          message.role,
          message.text,
          message.attachments_json,
          message.origin_json,
          message.is_streaming,
          message.created_at,
          message.updated_at,
          (
            SELECT COUNT(*)
            FROM projection_thread_messages AS earlier
            WHERE earlier.thread_id = message.thread_id
              AND earlier.role IN ('user', 'assistant')
              AND (
                earlier.created_at < message.created_at
                OR (
                  earlier.created_at = message.created_at
                  AND earlier.message_id <= message.message_id
                )
              )
          ) AS ordinal
        FROM projection_thread_messages AS message
        WHERE message.thread_id = ${threadId}
          AND message.role IN ('user', 'assistant')
        ORDER BY message.created_at DESC, message.message_id DESC
        LIMIT 1
      `;
      const latestUser = yield* sql<LegacyMessageRow>`
        SELECT
          message.message_id,
          message.thread_id,
          message.turn_id,
          message.role,
          message.text,
          message.attachments_json,
          message.origin_json,
          message.is_streaming,
          message.created_at,
          message.updated_at,
          (
            SELECT COUNT(*)
            FROM projection_thread_messages AS earlier
            WHERE earlier.thread_id = message.thread_id
              AND earlier.role IN ('user', 'assistant')
              AND (
                earlier.created_at < message.created_at
                OR (
                  earlier.created_at = message.created_at
                  AND earlier.message_id <= message.message_id
                )
              )
          ) AS ordinal
        FROM projection_thread_messages AS message
        WHERE message.thread_id = ${threadId}
          AND message.role = 'user'
        ORDER BY message.created_at DESC, message.message_id DESC
        LIMIT 1
      `;
      return [latestUser[0], latest[0]].filter(
        (message, index, selected): message is LegacyMessageRow =>
          message !== undefined &&
          selected.findIndex((candidate) => candidate?.message_id === message.message_id) === index,
      );
    });

  const reconcileShellsBase = Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const repairRows = yield* sql<LegacyRepairRow>`
      SELECT
        thread.thread_id,
        thread.project_id,
        thread.title,
        thread.model_selection_json,
        thread.runtime_mode,
        thread.interaction_mode,
        thread.branch,
        thread.worktree_path,
        thread.workspace_id,
        thread.title_mode,
        thread.skill_scope_json,
        thread.created_at,
        thread.updated_at,
        thread.archived_at,
        thread.settled_override,
        thread.settled_at,
        thread.unsettled_at,
        thread.snoozed_until,
        thread.snoozed_at,
        thread.pinned_at,
        thread.pin_order_key,
        thread.active_order_key,
        thread.linked_pull_request_json,
        thread.deleted_at,
        projection.payload_json
      FROM orchestration_v2_legacy_imports AS legacy_import
      INNER JOIN projection_threads AS thread
        ON thread.thread_id = legacy_import.thread_id
      INNER JOIN orchestration_v2_projection_threads AS projection
        ON projection.thread_id = legacy_import.thread_id
      WHERE json_type(projection.payload_json, '$.pinnedAt') IS NULL
         OR json_type(projection.payload_json, '$.pinOrderKey') IS NULL
         OR json_type(projection.payload_json, '$.snoozedUntil') IS NULL
         OR json_type(projection.payload_json, '$.snoozedAt') IS NULL
         OR json_type(projection.payload_json, '$.unsettledAt') IS NULL
         OR json_type(projection.payload_json, '$.activeOrderKey') IS NULL
         OR json_type(projection.payload_json, '$.linkedPullRequest') IS NULL
      ORDER BY thread.created_at ASC, thread.thread_id ASC
    `;
    let repairedThreadCount = 0;
    for (const row of repairRows) {
      const decoded = decodeStoredThread(row.payload_json);
      if (Option.isNone(decoded)) continue;
      const current = decoded.value;
      const legacy = importedThread(row);
      const repaired: OrchestrationV2AppThread = {
        ...current,
        pinnedAt: current.pinnedAt === undefined ? legacy.pinnedAt : current.pinnedAt,
        pinOrderKey: current.pinOrderKey === undefined ? legacy.pinOrderKey : current.pinOrderKey,
        activeOrderKey:
          current.activeOrderKey === undefined ? legacy.activeOrderKey : current.activeOrderKey,
        snoozedUntil:
          current.snoozedUntil === undefined ? legacy.snoozedUntil : current.snoozedUntil,
        snoozedAt: current.snoozedAt === undefined ? legacy.snoozedAt : current.snoozedAt,
        unsettledAt: current.unsettledAt === undefined ? legacy.unsettledAt : current.unsettledAt,
        linkedPullRequest:
          current.linkedPullRequest === undefined
            ? legacy.linkedPullRequest
            : current.linkedPullRequest,
      };
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${row.thread_id}:metadata-repair`),
            type: "thread.metadata-updated",
            threadId: repaired.id,
            providerInstanceId: repaired.providerInstanceId,
            occurredAt: dateTime(now),
            payload: repaired,
          },
        ],
      });
      repairedThreadCount += 1;
    }
    const rows = yield* sql<LegacyThreadRow>`
      SELECT
        thread.thread_id,
        thread.project_id,
        thread.title,
        thread.model_selection_json,
        thread.runtime_mode,
        thread.interaction_mode,
        thread.branch,
        thread.worktree_path,
        thread.workspace_id,
        thread.title_mode,
        thread.skill_scope_json,
        thread.created_at,
        thread.updated_at,
        thread.archived_at,
        thread.settled_override,
        thread.settled_at,
        thread.unsettled_at,
        thread.snoozed_until,
        thread.snoozed_at,
        thread.pinned_at,
        thread.pin_order_key,
        thread.active_order_key,
        thread.linked_pull_request_json,
        thread.deleted_at
      FROM projection_threads AS thread
      WHERE NOT EXISTS (
        SELECT 1
        FROM orchestration_events AS event
        WHERE event.application_event_version = 2
          AND event.aggregate_kind = 'thread'
          AND event.stream_id = thread.thread_id
          AND event.event_type = 'thread.created'
      )
      ORDER BY thread.created_at ASC, thread.thread_id ASC
    `;
    let importedThreadCount = repairedThreadCount;
    let importedMessageCount = 0;
    for (const row of rows) {
      let thread = importedThread(row);
      const allMessages = yield* listMessages(thread.id);
      const queueRows = yield* sql<LegacyQueuedMessageRow>`
        SELECT
          message_id,
          thread_id,
          text,
          attachments_json,
          origin_json,
          model_selection_json,
          title_seed,
          runtime_mode,
          interaction_mode,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          created_at,
          updated_at
        FROM projection_thread_queued_messages
        WHERE thread_id = ${thread.id}
        ORDER BY created_at ASC, message_id ASC
      `;
      const legacyTurns = yield* sql<LegacyTurnRow>`
        SELECT
          row_id,
          thread_id,
          turn_id,
          pending_message_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at
        FROM projection_turns
        WHERE thread_id = ${thread.id}
        ORDER BY requested_at DESC, row_id DESC
        LIMIT 1
      `;
      const sessions = yield* sql<LegacySessionRow>`
        SELECT provider_name, provider_instance_id, resume_cursor_json
        FROM provider_session_runtime WHERE thread_id = ${thread.id}
      `;
      const session = sessions[0];
      const sessionProviderInstanceId =
        session === undefined || session.provider_instance_id === null
          ? thread.providerInstanceId
          : ProviderInstanceId.make(session.provider_instance_id);
      const providerThreadsByInstance = new Map<
        ProviderInstanceId,
        OrchestrationV2ProviderThread
      >();
      if (session !== undefined) {
        const providerInstanceId = sessionProviderInstanceId;
        const driver = driverForLegacyProvider(session.provider_name, providerInstanceId);
        const nativeId = nativeIdForLegacySession(session, providerInstanceId);
        if (nativeId !== undefined) {
          const providerThread: OrchestrationV2ProviderThread = {
            id: ids.derive.providerThread({ driver, nativeThreadId: nativeId }),
            driver,
            providerInstanceId,
            providerSessionId: null,
            appThreadId: thread.id,
            ownerNodeId: null,
            nativeThreadRef: { driver, nativeId, strength: "strong" },
            nativeConversationHeadRef: null,
            status: "not_loaded",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            createdAt: thread.createdAt,
            updatedAt: thread.updatedAt,
          };
          providerThreadsByInstance.set(providerInstanceId, providerThread);
          thread = { ...thread, activeProviderThreadId: providerThread.id };
        }
      }
      const ensureProviderThread = (providerInstanceId: ProviderInstanceId) => {
        const existing = providerThreadsByInstance.get(providerInstanceId);
        if (existing !== undefined) return existing;
        const driver = driverForLegacyProvider(
          providerInstanceId === sessionProviderInstanceId
            ? (session?.provider_name ?? null)
            : null,
          providerInstanceId,
        );
        const nativeId = `legacy-pending:${thread.id}:${providerInstanceId}`;
        const pending: OrchestrationV2ProviderThread = {
          id: ids.derive.providerThread({ driver, nativeThreadId: nativeId }),
          driver,
          providerInstanceId,
          providerSessionId: null,
          appThreadId: thread.id,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "not_loaded",
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
        };
        providerThreadsByInstance.set(providerInstanceId, pending);
        return pending;
      };

      const latestTurn = legacyTurns[0];
      const terminalStatus =
        latestTurn === undefined || queueRows.length === 0
          ? null
          : legacyTerminalStatus(latestTurn.state);
      const legacyRunOrdinal = latestTurn === undefined || queueRows.length === 0 ? 0 : 1;
      const legacyRunMessageId =
        latestTurn === undefined
          ? null
          : (legacyTurnMessageId(latestTurn, allMessages) ??
            MessageId.make(
              `${IMPORT_EVENT_PREFIX}:turn:${thread.id}:${latestTurn.row_id}:message`,
            ));
      const legacyProviderThread =
        terminalStatus === null ? null : ensureProviderThread(thread.providerInstanceId);
      const importedRuns: Array<OrchestrationV2Run> = [];
      const importedAttempts: Array<OrchestrationV2RunAttempt> = [];
      const importedNodes: Array<OrchestrationV2ExecutionNode> = [];
      const queueMessages: Array<OrchestrationV2ConversationMessage> = [];

      if (latestTurn !== undefined && terminalStatus !== null && legacyProviderThread !== null) {
        const runId = ids.derive.run({ threadId: thread.id, ordinal: legacyRunOrdinal });
        const attemptId = ids.derive.runAttempt({ runId, attemptOrdinal: 1 });
        const rootNodeId = ids.derive.rootNode({ runId });
        const requestedAt = dateTime(latestTurn.requested_at);
        const startedAt =
          latestTurn.started_at === null
            ? terminalStatus === "completed"
              ? requestedAt
              : null
            : dateTime(latestTurn.started_at);
        const completedAt =
          latestTurn.completed_at === null
            ? dateTime(latestTurn.started_at ?? latestTurn.requested_at)
            : dateTime(latestTurn.completed_at);
        importedRuns.push({
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          id: runId,
          threadId: thread.id,
          ordinal: legacyRunOrdinal,
          providerInstanceId: thread.providerInstanceId,
          modelSelection: thread.modelSelection,
          providerThreadId: legacyProviderThread.id,
          userMessageId:
            legacyRunMessageId ??
            MessageId.make(`${IMPORT_EVENT_PREFIX}:turn:${thread.id}:${latestTurn.row_id}:message`),
          rootNodeId,
          activeAttemptId: attemptId,
          status: terminalStatus,
          queuePosition: null,
          requestedAt,
          startedAt,
          completedAt,
          checkpointId: null,
          contextHandoffId: null,
        });
        importedAttempts.push({
          id: attemptId,
          runId,
          attemptOrdinal: 1,
          rootNodeId,
          providerInstanceId: thread.providerInstanceId,
          providerThreadId: legacyProviderThread.id,
          providerTurnId: null,
          reason: "initial",
          status: terminalStatus,
          startedAt,
          completedAt,
        });
        importedNodes.push({
          id: rootNodeId,
          threadId: thread.id,
          runId,
          parentNodeId: null,
          rootNodeId,
          kind: "root_turn",
          status: terminalNodeStatus(terminalStatus),
          countsForRun: true,
          providerThreadId: legacyProviderThread.id,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt,
          completedAt,
        });
      }

      for (const [index, queued] of queueRows.entries()) {
        const ordinal = legacyRunOrdinal + index + 1;
        const modelSelection = modelSelectionFromJson(
          queued.model_selection_json,
          thread.modelSelection,
        );
        const queuedProviderThread = ensureProviderThread(modelSelection.instanceId);
        const runId = ids.derive.run({ threadId: thread.id, ordinal });
        const attemptId = ids.derive.runAttempt({ runId, attemptOrdinal: 1 });
        const rootNodeId = ids.derive.rootNode({ runId });
        const createdAt = dateTime(queued.created_at);
        const updatedAt = dateTime(queued.updated_at);
        const attachments = Option.getOrElse(
          decodeAttachments(parseJson(queued.attachments_json)),
          () => [],
        );
        const messageId = MessageId.make(queued.message_id);
        const origin = originFromJson(queued.origin_json);
        const message: OrchestrationV2ConversationMessage = {
          createdBy: "user",
          creationSource: "server",
          id: messageId,
          threadId: thread.id,
          runId,
          nodeId: rootNodeId,
          role: "user",
          ...(origin === undefined ? {} : { origin }),
          text: queued.text,
          attachments,
          streaming: false,
          createdAt,
          updatedAt,
        };
        queueMessages.push(message);
        const sourcePlanRef = legacySourcePlanRef(queued);
        importedRuns.push({
          runtimeMode: runtimeModeFor(queued.runtime_mode),
          interactionMode: interactionModeFor(queued.interaction_mode),
          id: runId,
          threadId: thread.id,
          ordinal,
          providerInstanceId: modelSelection.instanceId,
          modelSelection,
          providerThreadId: queuedProviderThread.id,
          userMessageId: messageId,
          rootNodeId,
          activeAttemptId: attemptId,
          status: "queued",
          queuePosition: index + 1,
          requestedAt: createdAt,
          startedAt: null,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
          ...(sourcePlanRef === undefined ? {} : { sourcePlanRef }),
        });
        importedAttempts.push({
          id: attemptId,
          runId,
          attemptOrdinal: 1,
          rootNodeId,
          providerInstanceId: modelSelection.instanceId,
          providerThreadId: queuedProviderThread.id,
          providerTurnId: null,
          reason: "initial",
          status: "pending",
          startedAt: null,
          completedAt: null,
        });
        importedNodes.push({
          id: rootNodeId,
          threadId: thread.id,
          runId,
          parentNodeId: null,
          rootNodeId,
          kind: "root_turn",
          status: "pending",
          countsForRun: true,
          providerThreadId: queuedProviderThread.id,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: null,
          completedAt: null,
        });
      }

      const providerThreadEvents: Array<OrchestrationV2DomainEvent> = [];
      for (const providerThread of providerThreadsByInstance.values()) {
        const runsForProvider = importedRuns.filter(
          (run) => run.providerThreadId === providerThread.id,
        );
        const updatedProviderThread: OrchestrationV2ProviderThread = {
          ...providerThread,
          firstRunOrdinal:
            runsForProvider.length === 0
              ? providerThread.firstRunOrdinal
              : Math.min(...runsForProvider.map((run) => run.ordinal)),
          lastRunOrdinal:
            runsForProvider.length === 0
              ? providerThread.lastRunOrdinal
              : Math.max(...runsForProvider.map((run) => run.ordinal)),
        };
        providerThreadsByInstance.set(
          updatedProviderThread.providerInstanceId,
          updatedProviderThread,
        );
        providerThreadEvents.push({
          id: EventId.make(
            `${IMPORT_EVENT_PREFIX}:thread:${row.thread_id}:provider-thread:${updatedProviderThread.providerInstanceId}`,
          ),
          type: "provider-thread.updated",
          threadId: thread.id,
          providerInstanceId: updatedProviderThread.providerInstanceId,
          occurredAt: updatedProviderThread.updatedAt,
          payload: updatedProviderThread,
        });
      }

      const previews = yield* listShellMessages(thread.id);
      const events: Array<OrchestrationV2DomainEvent> = [
        {
          id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${row.thread_id}:created`),
          type: "thread.created",
          threadId: thread.id,
          providerInstanceId: thread.providerInstanceId,
          occurredAt: thread.createdAt,
          payload: thread,
        },
        ...providerThreadEvents,
        ...importedRuns.map((run) => ({
          id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${row.thread_id}:run:${run.id}`),
          type: "run.created" as const,
          threadId: thread.id,
          runId: run.id,
          ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
          providerInstanceId: run.providerInstanceId,
          occurredAt: run.requestedAt,
          payload: run,
        })),
        ...importedAttempts.map((attempt) => ({
          id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${row.thread_id}:attempt:${attempt.id}`),
          type: "run-attempt.created" as const,
          threadId: thread.id,
          runId: attempt.runId,
          nodeId: attempt.rootNodeId,
          providerInstanceId: attempt.providerInstanceId,
          occurredAt: attempt.startedAt ?? attempt.completedAt ?? thread.createdAt,
          payload: attempt,
        })),
        ...importedNodes.map((node) => ({
          id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${row.thread_id}:node:${node.id}`),
          type: "node.updated" as const,
          threadId: thread.id,
          ...(node.runId === null ? {} : { runId: node.runId }),
          nodeId: node.id,
          providerInstanceId: thread.providerInstanceId,
          occurredAt: node.completedAt ?? node.startedAt ?? thread.createdAt,
          payload: node,
        })),
        ...previews.flatMap(messageEvents),
        ...queueMessages.map((message) => ({
          id: EventId.make(`${IMPORT_EVENT_PREFIX}:queued-message:${message.id}`),
          type: "message.updated" as const,
          threadId: thread.id,
          ...(message.runId === null ? {} : { runId: message.runId }),
          ...(message.nodeId === null ? {} : { nodeId: message.nodeId }),
          providerInstanceId: importedRuns.find((run) => run.userMessageId === message.id)
            ?.providerInstanceId,
          occurredAt: message.updatedAt,
          payload: message,
        })),
        {
          id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${row.thread_id}:shell`),
          type: "thread.metadata-updated",
          threadId: thread.id,
          providerInstanceId: thread.providerInstanceId,
          occurredAt: thread.updatedAt,
          payload: thread,
        },
      ];
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* eventStore.append({ events });
          yield* Effect.forEach(
            previews,
            (message) =>
              sql`
                INSERT INTO orchestration_v2_turn_item_positions (
                  thread_id,
                  turn_item_id,
                  ordinal
                )
                VALUES (
                  ${thread.id},
                  ${TurnItemId.make(`${IMPORT_EVENT_PREFIX}:turn-item:${message.message_id}`)},
                  ${message.ordinal}
                )
                ON CONFLICT(thread_id, turn_item_id) DO NOTHING
              `,
            { discard: true },
          );
          yield* sql`
            INSERT INTO orchestration_v2_legacy_imports (
              thread_id,
              source_updated_at,
              shell_imported_at,
              transcript_imported_at,
              imported_message_count,
              last_error
            )
            VALUES (
              ${thread.id},
              ${row.updated_at},
              ${now},
              NULL,
              ${previews.length + queueMessages.length},
              NULL
            )
            ON CONFLICT(thread_id) DO NOTHING
          `;
        }),
      );
      importedThreadCount += 1;
      importedMessageCount += previews.length + queueMessages.length;
    }
    return { importedThreadCount, importedMessageCount };
  });

  const reconcileShells = reconcileShellsBase.pipe(
    Effect.mapError((cause) => new LegacyV1ThreadImportError({ operation: "import", cause })),
  );

  const pendingThreadCount = sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count
    FROM (
      SELECT thread.thread_id
      FROM projection_threads AS thread
      WHERE NOT EXISTS (
        SELECT 1
        FROM orchestration_events AS event
        WHERE event.application_event_version = 2
          AND event.aggregate_kind = 'thread'
          AND event.stream_id = thread.thread_id
          AND event.event_type = 'thread.created'
      )
      UNION
      SELECT legacy_import.thread_id
      FROM orchestration_v2_legacy_imports AS legacy_import
      WHERE legacy_import.transcript_imported_at IS NULL
    )
  `.pipe(
    Effect.map((rows) => rows[0]?.count ?? 0),
    Effect.mapError(
      (cause) => new LegacyV1ThreadImportError({ operation: "inspect pending", cause }),
    ),
  );

  // Threads whose transcript import this process has already confirmed.
  // `transcript_imported_at` is never reset to NULL, so a positive answer
  // stays valid for the process lifetime; ensureTranscript runs on most
  // thread reads and command dispatches, so skipping the lock + lookup here
  // keeps that path off the database entirely after first confirmation.
  const confirmedTranscriptThreadIds = new Set<ThreadId>();

  const ensureTranscriptBase = (threadId: ThreadId) =>
    transcriptImports.withLock(
      threadId,
      Effect.gen(function* () {
        const imports = yield* sql<LegacyImportRow>`
          SELECT thread_id, transcript_imported_at
          FROM orchestration_v2_legacy_imports
          WHERE thread_id = ${threadId}
          LIMIT 1
        `;
        const imported = imports[0];
        if (imported === undefined || imported.transcript_imported_at !== null) {
          if (imported !== undefined) {
            confirmedTranscriptThreadIds.add(threadId);
          }
          return { importedThreadCount: 0, importedMessageCount: 0 };
        }
        const messages = yield* listMessages(threadId);
        const existingRows = yield* sql<{ readonly event_id: string }>`
          SELECT event_id
          FROM orchestration_events
          WHERE application_event_version = 2
            AND aggregate_kind = 'thread'
            AND stream_id = ${threadId}
            AND event_id LIKE ${`${IMPORT_EVENT_PREFIX}:message:%`}
        `;
        const existing = new Set(existingRows.map((row) => row.event_id));
        const missing = messages.filter(
          (message) => !existing.has(`${IMPORT_EVENT_PREFIX}:message:${message.message_id}`),
        );
        for (const batch of chunks(missing, TRANSCRIPT_EVENT_BATCH_SIZE / 2)) {
          yield* Effect.forEach(
            batch,
            (message) =>
              sql`
                INSERT INTO orchestration_v2_turn_item_positions (
                  thread_id,
                  turn_item_id,
                  ordinal
                )
                VALUES (
                  ${threadId},
                  ${TurnItemId.make(`${IMPORT_EVENT_PREFIX}:turn-item:${message.message_id}`)},
                  ${message.ordinal}
                )
                ON CONFLICT(thread_id, turn_item_id) DO NOTHING
              `,
            { discard: true },
          );
          yield* eventSink.write({ events: batch.flatMap(messageEvents) });
          yield* Effect.yieldNow;
        }
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* sql`
          UPDATE orchestration_v2_legacy_imports
          SET
            transcript_imported_at = ${now},
            imported_message_count = ${messages.length},
            last_error = NULL
          WHERE thread_id = ${threadId}
        `;
        confirmedTranscriptThreadIds.add(threadId);
        return {
          importedThreadCount: 1,
          importedMessageCount: missing.length,
        };
      }),
    );

  const ensureTranscript = (threadId: ThreadId) =>
    confirmedTranscriptThreadIds.has(threadId)
      ? Effect.succeed({ importedThreadCount: 0, importedMessageCount: 0 })
      : ensureTranscriptBase(threadId).pipe(
          Effect.mapError(
            (cause) =>
              new LegacyV1ThreadImportError({
                operation: "hydrate transcript for",
                threadId,
                cause,
              }),
          ),
        );

  const importPendingTranscripts = Effect.gen(function* () {
    const rows = yield* sql<LegacyImportRow>`
      SELECT thread_id, transcript_imported_at
      FROM orchestration_v2_legacy_imports
      WHERE transcript_imported_at IS NULL
      ORDER BY shell_imported_at ASC, thread_id ASC
    `;
    let importedThreadCount = 0;
    let importedMessageCount = 0;
    for (const row of rows) {
      const result = yield* ensureTranscript(ThreadId.make(row.thread_id)).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Failed to hydrate migrated v1 thread transcript", {
            threadId: row.thread_id,
            cause: error,
          }),
        ),
        Effect.catch(() =>
          sql`
            UPDATE orchestration_v2_legacy_imports
            SET last_error = 'Transcript hydration failed; retry on next open.'
            WHERE thread_id = ${row.thread_id}
          `.pipe(
            Effect.as({ importedThreadCount: 0, importedMessageCount: 0 }),
            Effect.orElseSucceed(() => ({
              importedThreadCount: 0,
              importedMessageCount: 0,
            })),
          ),
        ),
      );
      importedThreadCount += result.importedThreadCount;
      importedMessageCount += result.importedMessageCount;
      yield* Effect.yieldNow;
    }
    return { importedThreadCount, importedMessageCount };
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Legacy v1 transcript background import stopped", { cause }).pipe(
        Effect.as({ importedThreadCount: 0, importedMessageCount: 0 }),
      ),
    ),
  );

  return LegacyV1ThreadImporter.of({
    pendingThreadCount,
    reconcileShells,
    ensureTranscript,
    importPendingTranscripts,
  });
});

export const layer: Layer.Layer<
  LegacyV1ThreadImporter,
  never,
  EventSinkV2 | EventStoreV2 | SqlClient.SqlClient
> = Layer.effect(LegacyV1ThreadImporter, make).pipe(Layer.provide(idAllocatorLayer));
