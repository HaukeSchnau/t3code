/** Import recent provider transcripts into the native orchestration V2 stream. */
import {
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionScanError,
  AgentSessionImportSource,
  EventId,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ProviderDriverKind,
  type AgentSessionImportResult,
  type AgentSessionSource,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type Project,
  type ProjectId,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "./ProjectService.ts";
import * as Scanner from "./AgentSessionScanner.ts";

const IMPORT_FINGERPRINT_PREFIX = "import:agent-session:sources:";
const IMPORT_ITEM_PREFIX = "import:agent-session";

export interface ImportRecentAgentThreadsInput {
  readonly projectId: ProjectId;
  readonly expectedWorkspaceRoot?: string;
}

export type ImportRecentAgentThreadsError =
  | AgentSessionImportProjectChangedError
  | AgentSessionImportProjectNotFoundError
  | AgentSessionScanError;

type ImportedProviderThread = OrchestrationV2ThreadProjection["providerThreads"][number];
type Services =
  | ProjectService.ProjectService
  | Scanner.AgentSessionScanner
  | ThreadManagement.ThreadManagementService
  | EventSink.EventSinkV2
  | IdAllocator.IdAllocatorV2;

const iso = (value: string): DateTime.Utc => DateTime.makeUnsafe(value);

function threadIdFor(source: Scanner.AgentSessionThread): ThreadId {
  return `import:${source.providerInstanceId}:${source.providerSessionId}` as ThreadId;
}

function driverFor(source: AgentSessionSource): ProviderDriverKind {
  return ProviderDriverKind.make(source);
}

function sourceKey(source: AgentSessionImportSource): string {
  return encodeURIComponent(JSON.stringify(source));
}

function encodeSources(sources: ReadonlyArray<AgentSessionImportSource>): string {
  return `${IMPORT_FINGERPRINT_PREFIX}${encodeURIComponent(JSON.stringify(sources))}`;
}

function decodeSources(provider: ImportedProviderThread): ReadonlyArray<AgentSessionImportSource> {
  const fingerprint = provider.nativeThreadRef?.fingerprint;
  if (fingerprint === undefined || !fingerprint.startsWith(IMPORT_FINGERPRINT_PREFIX)) return [];
  const encoded = fingerprint.slice(IMPORT_FINGERPRINT_PREFIX.length);
  try {
    const value = JSON.parse(decodeURIComponent(encoded));
    const decoded = Schema.decodeUnknownOption(Schema.Array(AgentSessionImportSource))(value);
    return Option.isSome(decoded) ? decoded.value : [];
  } catch {
    return [];
  }
}

function isImportedProviderThread(
  provider: ImportedProviderThread,
  threadId: ThreadId,
  source: Scanner.AgentSessionThread,
): boolean {
  return (
    provider.appThreadId === threadId &&
    provider.driver === driverFor(source.source) &&
    provider.providerInstanceId === source.providerInstanceId &&
    provider.providerSessionId === null &&
    provider.ownerNodeId === null &&
    provider.firstRunOrdinal === null &&
    provider.lastRunOrdinal === null &&
    provider.handoffIds.length === 0 &&
    (provider.pendingBackgroundTasks?.length ?? 0) === 0 &&
    provider.nativeThreadRef?.nativeId === source.providerSessionId &&
    provider.nativeThreadRef.strength === "strong" &&
    (provider.status === "not_loaded" || provider.status === "idle")
  );
}

function hasImportBlockingActivity(projection: OrchestrationV2ThreadProjection): boolean {
  const { thread } = projection;
  if (
    thread.archivedAt !== null ||
    thread.deletedAt !== null ||
    thread.snoozedUntil !== undefined && thread.snoozedUntil !== null ||
    thread.snoozedAt !== undefined && thread.snoozedAt !== null ||
    thread.pinnedAt !== undefined && thread.pinnedAt !== null ||
    thread.titleRegeneration !== undefined && thread.titleRegeneration !== null ||
    thread.linkedPullRequest !== undefined && thread.linkedPullRequest !== null ||
    projection.runs.length > 0 ||
    projection.attempts.length > 0 ||
    projection.nodes.length > 0 ||
    projection.subagents.length > 0 ||
    projection.providerSessions.length > 0 ||
    projection.providerTurns.length > 0 ||
    projection.runtimeRequests.length > 0 ||
    projection.plans.length > 0 ||
    projection.checkpointScopes.length > 0 ||
    projection.checkpoints.length > 0 ||
    projection.contextHandoffs.length > 0 ||
    projection.contextTransfers.length > 0 ||
    projection.messages.some((message) => !message.id.startsWith("import:")) ||
    projection.turnItems.some((item) => !item.id.startsWith(IMPORT_ITEM_PREFIX)) ||
    projection.providerThreads.some(
      (provider) =>
        provider.appThreadId !== null &&
        !isImportedProviderThread(provider, thread.id, {
          source: provider.driver === ProviderDriverKind.make("codex") ? "codex" : "claudeAgent",
          providerInstanceId: provider.providerInstanceId,
          providerSessionId: provider.nativeThreadRef?.nativeId ?? "",
          title: "",
          model: null,
          createdAt: DateTime.formatIso(provider.createdAt),
          updatedAt: DateTime.formatIso(provider.updatedAt),
          messages: [],
        }),
    ) ||
    thread.settledOverride !== "settled" ||
    thread.settledAt === null
  ) {
    return true;
  }
  if (thread.activeProviderThreadId !== null) {
    const active = projection.providerThreads.find((provider) => provider.id === thread.activeProviderThreadId);
    if (active === undefined || !active.nativeThreadRef || active.status === "active") return true;
  }
  return false;
}

function makeProviderThread(
  source: Scanner.AgentSessionThread,
  threadId: ThreadId,
  providerThreadId: OrchestrationV2ProviderThread["id"],
  createdAt: DateTime.Utc,
  updatedAt: DateTime.Utc,
  sources: ReadonlyArray<AgentSessionImportSource>,
): OrchestrationV2ProviderThread {
  return {
    id: providerThreadId,
    driver: driverFor(source.source),
    providerInstanceId: source.providerInstanceId,
    providerSessionId: null,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: {
      driver: driverFor(source.source),
      nativeId: source.providerSessionId,
      strength: "strong",
      fingerprint: encodeSources(sources),
    },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    pendingBackgroundTasks: [],
    createdAt,
    updatedAt,
  };
}

function makeThread(
  source: Scanner.AgentSessionThread,
  project: Project,
  threadId: ThreadId,
  providerThreadId: OrchestrationV2ProviderThread["id"],
): OrchestrationV2AppThread {
  const createdAt = iso(source.createdAt);
  const updatedAt = iso(source.updatedAt);
  const modelSelection: ModelSelection = {
    instanceId: source.providerInstanceId,
    model: source.model ?? DEFAULT_MODEL_BY_PROVIDER[driverFor(source.source)] ?? DEFAULT_MODEL,
  };
  return {
    createdBy: "system",
    creationSource: "server",
    id: threadId,
    projectId: project.id,
    title: source.title.trim() || "Imported session",
    providerInstanceId: source.providerInstanceId,
    modelSelection,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    activeProviderThreadId: providerThreadId,
    historyOrigin: "native",
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt,
    updatedAt,
    archivedAt: null,
    settledOverride: "settled",
    settledAt: updatedAt,
    unsettledAt: undefined,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    lastVisitedAt: null,
    titleRegeneration: null,
    deletedAt: null,
    workspaceId: null,
    titleMode: "automatic",
    skillScope: undefined,
    linkedPullRequest: undefined,
  };
}

function makeMessage(
  source: Scanner.AgentSessionThread,
  message: Scanner.AgentSessionThreadMessage,
  threadId: ThreadId,
  index: number,
): OrchestrationV2ConversationMessage {
  const id = `${threadId}:${String(index).padStart(6, "0")}` as OrchestrationV2ConversationMessage["id"];
  const timestamp = iso(message.createdAt);
  return {
    createdBy: message.role === "user" ? "user" : "agent",
    creationSource: "server",
    id,
    threadId,
    runId: null,
    nodeId: null,
    role: message.role,
    text: message.text,
    attachments: [],
    streaming: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function makeTurnItem(
  source: Scanner.AgentSessionThread,
  message: Scanner.AgentSessionThreadMessage,
  threadId: ThreadId,
  providerThreadId: OrchestrationV2ProviderThread["id"],
  index: number,
  messageId: OrchestrationV2ConversationMessage["id"],
): OrchestrationV2TurnItem {
  const timestamp = iso(message.createdAt);
  const base = {
    id: `${IMPORT_ITEM_PREFIX}:${threadId}:turn-item:${String(index).padStart(6, "0")}` as OrchestrationV2TurnItem["id"],
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: index,
    status: "completed" as const,
    title: null,
    startedAt: timestamp,
    completedAt: timestamp,
    updatedAt: timestamp,
  };
  return message.role === "user"
    ? {
        ...base,
        createdBy: "user",
        creationSource: "server",
        type: "user_message",
        messageId,
        inputIntent: "turn_start",
        text: message.text,
        attachments: [],
      }
    : {
        ...base,
        type: "assistant_message",
        messageId,
        text: message.text,
        attachments: [],
        streaming: false,
      };
}

function sourceEvent(
  providerThread: OrchestrationV2ProviderThread,
  threadId: ThreadId,
  source: AgentSessionImportSource,
  driver: ProviderDriverKind,
): OrchestrationV2DomainEvent {
  return {
    id: EventId.make(`import:agent-session:source:${sourceKey(source)}`),
    type: "provider-thread.updated",
    threadId,
    occurredAt: providerThread.updatedAt,
    driver,
    providerInstanceId: providerThread.providerInstanceId,
    payload: providerThread,
  };
}

function projectionOption(
  service: ThreadManagement.ThreadManagementService["Service"],
  threadId: ThreadId,
): Effect.Effect<Option.Option<OrchestrationV2ThreadProjection>, never> {
  return service.getThreadProjection(threadId).pipe(
    Effect.map(Option.some),
    Effect.catch(() => Effect.succeed(Option.none())),
  );
}

function projectSources(
  service: ThreadManagement.ThreadManagementService["Service"],
  projectId: ProjectId,
): Effect.Effect<ReadonlyArray<AgentSessionImportSource>, AgentSessionScanError> {
  return Effect.gen(function* () {
    const shells = yield* service.listProjectThreads({ projectId, includeSubagents: true }).pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
    );
    const projections = yield* Effect.forEach(shells, (shell) =>
      service.getThreadProjection(shell.id).pipe(
        Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
      ),
    );
    return projections.flatMap((projection) => projection.providerThreads.flatMap(decodeSources));
  });
}

function importThread(
  source: Scanner.AgentSessionThread,
  sourceIdentity: AgentSessionImportSource,
  project: Project,
  existing: Option.Option<OrchestrationV2ThreadProjection>,
  eventSink: EventSink.EventSinkV2["Service"],
  ids: IdAllocator.IdAllocatorV2["Service"],
): Effect.Effect<boolean, EventSink.EventSinkV2Error | IdAllocator.IdAllocatorV2Error> {
  return Effect.gen(function* () {
    const threadId = threadIdFor(source);
    const driver = driverFor(source.source);
    const projection = Option.isSome(existing) ? existing.value : undefined;
    if (projection !== undefined && projection.thread.projectId !== project.id) return false;
    if (projection !== undefined && hasImportBlockingActivity(projection)) return false;

    const matchingProvider = projection?.providerThreads.find((provider) =>
      isImportedProviderThread(provider, threadId, source),
    );
    const providerThreadId =
      matchingProvider?.id ?? ids.derive.providerThread({ driver, nativeThreadId: source.providerSessionId });
    const oldSources = matchingProvider?.nativeThreadRef ? decodeSources(matchingProvider) : [];
    if (oldSources.some((candidate) => sourceKey(candidate) === sourceKey(sourceIdentity))) return true;
    const sources = [...oldSources, sourceIdentity];
    const createdAt = projection?.thread.createdAt ?? iso(source.createdAt);
    const updatedAt = iso(source.updatedAt);
    const providerThread = makeProviderThread(
      source,
      threadId,
      providerThreadId,
      matchingProvider?.createdAt ?? createdAt,
      updatedAt,
      sources,
    );
    const events: Array<OrchestrationV2DomainEvent> = [];
    if (projection === undefined) {
      events.push({
        id: EventId.make(`import:agent-session:${threadId}:created`),
        type: "thread.created",
        threadId,
        occurredAt: createdAt,
        driver,
        providerInstanceId: source.providerInstanceId,
        payload: makeThread(source, project, threadId, providerThreadId),
      });
      for (const [index, message] of source.messages.entries()) {
        const payload = makeMessage(source, message, threadId, index);
        events.push({
          id: EventId.make(`import:agent-session:${threadId}:message:${String(index).padStart(6, "0")}`),
          type: "message.updated",
          threadId,
          occurredAt: payload.updatedAt,
          driver,
          providerInstanceId: source.providerInstanceId,
          payload,
        });
        events.push({
          id: EventId.make(`import:agent-session:${threadId}:turn-item:${String(index).padStart(6, "0")}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: payload.updatedAt,
          driver,
          providerInstanceId: source.providerInstanceId,
          payload: makeTurnItem(source, message, threadId, providerThreadId, index, payload.id),
        });
      }
    } else if (
      projection.thread.activeProviderThreadId !== providerThreadId ||
      projection.thread.historyOrigin !== "native"
    ) {
      events.push({
        id: EventId.make(`import:agent-session:${threadId}:metadata`),
        type: "thread.metadata-updated",
        threadId,
        occurredAt: updatedAt,
        driver,
        providerInstanceId: source.providerInstanceId,
        payload: {
          ...projection.thread,
          activeProviderThreadId: providerThreadId,
          historyOrigin: "native",
          settledOverride: "settled",
          settledAt: projection.thread.settledAt ?? updatedAt,
          updatedAt,
        },
      });
    }
    events.push(sourceEvent(providerThread, threadId, sourceIdentity, driver));
    yield* eventSink.write({ events });
    return true;
  });
}

/** Import scanner results atomically, retaining native provider resume identity. */
export function importRecentAgentThreads(
  input: ImportRecentAgentThreadsInput,
): Effect.Effect<AgentSessionImportResult, ImportRecentAgentThreadsError, Services> {
  return Effect.gen(function* () {
    const projects = yield* ProjectService.ProjectService;
    const scanner = yield* Scanner.AgentSessionScanner;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const eventSink = yield* EventSink.EventSinkV2;
    const ids = yield* IdAllocator.IdAllocatorV2;
    const projectOption = yield* projects.getById(input.projectId).pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
    );
    if (Option.isNone(projectOption)) return yield* new AgentSessionImportProjectNotFoundError({ projectId: input.projectId });
    const project = projectOption.value;
    if (
      input.expectedWorkspaceRoot !== undefined &&
      normalizeProjectPathForComparison(input.expectedWorkspaceRoot) !==
        normalizeProjectPathForComparison(project.workspaceRoot)
    ) {
      return yield* new AgentSessionImportProjectChangedError({ projectId: input.projectId });
    }
    const completedSources = yield* projectSources(threads, input.projectId);
    let importedCount = 0;
    let skippedCount = 0;
    yield* Stream.runForEach(
      scanner.recentThreads(project.workspaceRoot, completedSources),
      (outcome) =>
        Effect.gen(function* () {
          if (outcome._tag === "Skipped") {
            skippedCount += 1;
            return;
          }
          if (outcome._tag === "AlreadyImported") {
            importedCount += 1;
            return;
          }
          if (outcome._tag === "Duplicate") {
            // The scanner has already emitted the first transcript for this
            // provider session. A duplicate only carries file identity, so
            // there is no parsed thread to import a second time.
            skippedCount += 1;
            return;
          }
          if (outcome._tag !== "Importable") {
            skippedCount += 1;
            return;
          }
          const threadId = threadIdFor(outcome.thread);
          const existing = yield* projectionOption(threads, threadId);
          const didWrite = yield* importThread(
            outcome.thread,
            outcome.source,
            project,
            existing,
            eventSink,
            ids,
          ).pipe(Effect.catch(() => Effect.succeed(false)));
          if (didWrite) {
            importedCount += 1;
          } else {
            skippedCount += 1;
          }
        }),
    );
    return { importedCount, skippedCount };
  });
}
