import type {
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ProviderThread,
  OrchestrationV2Run,
  OrchestrationV2ThreadShell,
  OrchestrationV2TurnItem,
  ThreadId,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import { isOrchestrationV2WorkActive, isProviderNativeSubagentThread } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Predicate from "effect/Predicate";

import { resolveT3McpToolId } from "./t3McpToolPresentation.ts";

const BACKGROUND_TURN_ITEM_TYPES = new Set<OrchestrationV2TurnItem["type"]>([
  "command_execution",
  "dynamic_tool",
  "subagent",
]);

// Plans and text streams can stay open across tool calls without executing work.
const EXECUTION_TURN_ITEM_TYPES = new Set<OrchestrationV2TurnItem["type"]>([
  ...BACKGROUND_TURN_ITEM_TYPES,
  "file_change",
  "file_search",
  "web_search",
  "compaction",
]);

const TERMINAL_RUN_STATUSES = new Set<OrchestrationV2Run["status"]>([
  "cancelled",
  "completed",
  "failed",
  "interrupted",
  "rolled_back",
]);

// waiting is completed work awaiting checkpoints; exclude rolled_back entirely because provider threads are not run-tied.
const SETTLED_FOR_BACKGROUND_WAIT_RUN_STATUSES = new Set<OrchestrationV2Run["status"]>([
  "cancelled",
  "completed",
  "failed",
  "interrupted",
  "waiting",
]);

void TERMINAL_RUN_STATUSES;

export type PendingBackgroundWorkTask = OrchestrationV2PendingBackgroundTask;

export function turnItemUpdateCanEndBackgroundWork(
  item: Pick<OrchestrationV2TurnItem, "type" | "status">,
): boolean {
  return BACKGROUND_TURN_ITEM_TYPES.has(item.type) && !isOrchestrationV2WorkActive(item.status);
}

export function deriveBlockedOnThreadWait(input: {
  readonly activeRun: Pick<OrchestrationV2Run, "id" | "status"> | null;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
}): boolean {
  if (input.activeRun?.status !== "running") return false;
  let hasWait = false;
  for (const item of input.turnItems) {
    if (
      item.runId !== input.activeRun.id ||
      !EXECUTION_TURN_ITEM_TYPES.has(item.type) ||
      (item.status !== "running" && item.status !== "waiting") ||
      // App-owned rows track the child, including the child a blocking delegate is waiting for.
      (item.type === "subagent" && item.origin === "app_owned")
    ) {
      continue;
    }
    if (item.type !== "dynamic_tool") return false;
    const tool = resolveT3McpToolId(item.toolName);
    if (
      tool !== "t3_thread_wait" &&
      !(
        tool === "delegate_task" &&
        Predicate.isObject(item.input) &&
        Reflect.get(item.input, "mode") === "wait"
      )
    ) {
      return false;
    }
    hasWait = true;
  }
  return hasWait;
}

export function backgroundWorkHoldsCompletion(
  tasks: ReadonlyArray<Pick<PendingBackgroundWorkTask, "kind" | "awaited">>,
): boolean {
  return tasks.some(taskHoldsCompletion);
}

function taskHoldsCompletion(task: Pick<PendingBackgroundWorkTask, "kind" | "awaited">): boolean {
  return task.awaited === true || backgroundWorkKindHoldsCompletion(task.kind);
}

// Commands and monitors are as often a dev server or its watchdog as a wait, so they hold
// only when the agent marks them awaited.
function backgroundWorkKindHoldsCompletion(kind: PendingBackgroundWorkTask["kind"]): boolean {
  switch (kind) {
    case "command":
    case "monitor":
      return false;
    case "subagent":
    case "background_task":
      return true;
  }
}

/** A monitor wakes the agent once per line, so a progress wake run's completion waits for the monitor to end. */
export function monitorHoldsWakeCompletion(
  thread: Pick<OrchestrationV2ThreadShell, "latestRunBackgroundWake" | "pendingBackgroundTasks">,
): boolean {
  return (
    thread.latestRunBackgroundWake === true &&
    (thread.pendingBackgroundTasks ?? []).some((task) => task.kind === "monitor")
  );
}

type PendingBackgroundWorkRun = Pick<OrchestrationV2Run, "id" | "ordinal" | "status">;

type PendingBackgroundWorkPullRequest = Pick<
  ThreadPullRequestLink,
  "host" | "repository" | "number" | "url" | "source" | "watch"
>;

type PendingBackgroundWorkProviderThread = Pick<
  OrchestrationV2ProviderThread,
  "id" | "pendingBackgroundTasks"
> & { readonly providerInstanceId?: OrchestrationV2ProviderThread["providerInstanceId"] };

type PendingBackgroundWorkTurnItem = {
  readonly id: OrchestrationV2TurnItem["id"] | string;
  readonly type: OrchestrationV2TurnItem["type"];
  readonly status: OrchestrationV2TurnItem["status"];
  readonly title: string | null;
  /** Shell readers join the owner, even when its provider thread belongs to a child app thread. */
  readonly owningProviderInstanceId?: OrchestrationV2ProviderThread["providerInstanceId"];
  readonly runId?: OrchestrationV2Run["id"] | string | null;
  readonly nativeItemRef?: {
    readonly nativeId: string | null;
  } | null;
  readonly input?: unknown;
  readonly monitor?: boolean | undefined;
  readonly prompt?: string | undefined;
  readonly childThreadId?: ThreadId | null;
  readonly startedAt?: DateTime.Utc | null;
};

/** An open `t3_watch` watch, which the agent always waits on. */
export interface PendingBackgroundWorkWatch {
  readonly watchId: string;
  readonly label: string | null;
  readonly command: string | null;
  readonly createdAt: string;
  readonly deadlineAt: string | null;
}

function isLatestRunSettledForBackgroundWait(
  latestRun: PendingBackgroundWorkRun | null | undefined,
): boolean {
  if (latestRun === undefined || latestRun === null) {
    return false;
  }
  return SETTLED_FOR_BACKGROUND_WAIT_RUN_STATUSES.has(latestRun.status);
}

function isPersistentDynamicToolInput(input: unknown): boolean {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return false;
  }
  return Reflect.get(input, "persistent") === true;
}

function descriptionFromTurnItem(item: PendingBackgroundWorkTurnItem): string | undefined {
  if (typeof item.title === "string" && item.title.trim().length > 0) {
    return item.title.trim();
  }
  if (item.type === "command_execution" && typeof item.input === "string") {
    const command = item.input.trim();
    return command.length > 0 ? command : undefined;
  }
  if (item.type === "dynamic_tool") {
    const toolName = Reflect.get(item, "toolName");
    if (typeof toolName === "string" && toolName.trim().length > 0) {
      return toolName.trim();
    }
  }
  if (item.type === "subagent" && typeof item.prompt === "string") {
    const prompt = item.prompt.trim();
    return prompt.length > 0 ? prompt : undefined;
  }
  return undefined;
}

function pendingTaskFromTurnItem(
  taskId: string,
  item: PendingBackgroundWorkTurnItem,
): PendingBackgroundWorkTask {
  const description = descriptionFromTurnItem(item);
  const named = {
    taskId,
    ...(description === undefined ? {} : { description }),
    ...(item.startedAt == null ? {} : { startedAt: DateTime.formatIso(item.startedAt) }),
  };
  switch (item.type) {
    case "subagent":
      return {
        ...named,
        kind: "subagent",
        ...(item.owningProviderInstanceId === undefined
          ? {}
          : { providerInstanceId: item.owningProviderInstanceId }),
        ...(item.childThreadId == null ? {} : { childThreadId: item.childThreadId }),
      };
    case "command_execution":
      return { ...named, kind: item.monitor === true ? "monitor" : "command" };
    default:
      return { ...named, kind: "background_task" };
  }
}

function nativeTaskIdFromTurnItem(item: PendingBackgroundWorkTurnItem): string {
  const nativeId = item.nativeItemRef?.nativeId;
  if (typeof nativeId === "string" && nativeId.length > 0) {
    return nativeId;
  }
  return String(item.id);
}

/** Items Stop ends, without the pending list's settled-run gate. */
export function pendingBackgroundTurnItems<Item extends PendingBackgroundWorkTurnItem>(input: {
  readonly turnItems: ReadonlyArray<Item>;
  readonly runs?: ReadonlyArray<PendingBackgroundWorkRun>;
}): ReadonlyArray<Item> {
  const rolledBackRunIds = new Set(
    (input.runs ?? []).filter((run) => run.status === "rolled_back").map((run) => String(run.id)),
  );
  return input.turnItems.filter(
    (item) =>
      BACKGROUND_TURN_ITEM_TYPES.has(item.type) &&
      isOrchestrationV2WorkActive(item.status) &&
      !(item.type === "dynamic_tool" && isPersistentDynamicToolInput(item.input)) &&
      (item.runId === undefined ||
        item.runId === null ||
        !rolledBackRunIds.has(String(item.runId))),
  );
}

export function derivePendingBackgroundWork(input: {
  readonly latestRun: PendingBackgroundWorkRun | null | undefined;
  readonly providerThreads: ReadonlyArray<PendingBackgroundWorkProviderThread>;
  readonly turnItems: ReadonlyArray<PendingBackgroundWorkTurnItem>;
  readonly activeProviderThreadId?: string | null;
  readonly hasActiveRun?: boolean;
  /** Excludes rolled-back runs; optional only when the caller already filtered them, as SQL shell reads do. */
  readonly runs?: ReadonlyArray<PendingBackgroundWorkRun>;
  readonly pullRequests?: ReadonlyArray<PendingBackgroundWorkPullRequest> | undefined;
  readonly watches?: ReadonlyArray<PendingBackgroundWorkWatch> | undefined;
}): ReadonlyArray<PendingBackgroundWorkTask> {
  const hasActiveRun =
    input.hasActiveRun ??
    input.runs?.some(
      (run) => run.status === "preparing" || run.status === "starting" || run.status === "running",
    ) ??
    false;
  if (hasActiveRun) {
    return [];
  }
  if (input.latestRun == null) {
    return [...pullRequestWatchTasks(input.pullRequests), ...agentWatchTasks(input.watches)];
  }
  if (!isLatestRunSettledForBackgroundWait(input.latestRun)) {
    return [];
  }

  const byTaskId = new Map<string, PendingBackgroundWorkTask>();

  const providerThreads =
    input.activeProviderThreadId === undefined || input.activeProviderThreadId === null
      ? input.providerThreads
      : input.providerThreads.filter((thread) => thread.id === input.activeProviderThreadId);

  for (const providerThread of providerThreads) {
    for (const task of providerThread.pendingBackgroundTasks ?? []) {
      if (task.taskId.length === 0 || byTaskId.has(task.taskId)) {
        continue;
      }
      const { description: rawDescription, ...named } = task;
      const description = rawDescription?.trim();
      const itemStartedAt =
        task.startedAt === undefined && task.itemId !== undefined
          ? input.turnItems.find((item) => item.id === task.itemId)?.startedAt
          : undefined;
      byTaskId.set(task.taskId, {
        ...named,
        ...(itemStartedAt == null ? {} : { startedAt: DateTime.formatIso(itemStartedAt) }),
        ...(task.kind === "subagent"
          ? { providerInstanceId: providerThread.providerInstanceId }
          : {}),
        ...(description === undefined || description.length === 0 ? {} : { description }),
      });
    }
  }

  for (const item of pendingBackgroundTurnItems(input)) {
    const taskId = nativeTaskIdFromTurnItem(item);
    if (byTaskId.has(taskId)) {
      continue;
    }

    byTaskId.set(taskId, pendingTaskFromTurnItem(taskId, item));
  }

  for (const task of pullRequestWatchTasks(input.pullRequests)) byTaskId.set(task.taskId, task);
  for (const task of agentWatchTasks(input.watches)) byTaskId.set(task.taskId, task);

  return Array.from(byTaskId.values());
}

const AGENT_WATCH_TASK_PREFIX = "watch:";

/** A `t3_watch` watch: the agent cancels it, and only the server's shell lists it. */
export function isAgentWatchTask(task: Pick<PendingBackgroundWorkTask, "taskId">): boolean {
  return task.taskId.startsWith(AGENT_WATCH_TASK_PREFIX);
}

function agentWatchTasks(
  watches: ReadonlyArray<PendingBackgroundWorkWatch> | undefined,
): Array<PendingBackgroundWorkTask> {
  return (watches ?? []).map((watch) => {
    const description = watch.label?.trim() || watch.command?.trim();
    return {
      taskId: `${AGENT_WATCH_TASK_PREFIX}${watch.watchId}`,
      kind: "monitor" as const,
      awaited: true as const,
      ...(description ? { description } : {}),
      ...(watch.command === null ? {} : { command: watch.command }),
      startedAt: watch.createdAt,
      ...(watch.deadlineAt === null ? {} : { expectedBy: watch.deadlineAt }),
    };
  });
}

const WAIT_CHECK_IN_MIN_MS = 30 * 60_000;
const WAIT_CHECK_IN_MAX_MS = 4 * 60 * 60_000;

type WaitCheckInThread = Pick<
  OrchestrationV2ThreadShell,
  | "archivedAt"
  | "deletedAt"
  | "settledOverride"
  | "settledAt"
  | "lineage"
  | "creationSource"
  | "activeRunId"
  | "activityRunStatus"
  | "pendingRuntimeRequest"
  | "latestRunStopRequested"
  | "lastErrorClass"
  | "latestRunCompletedAt"
  | "pendingBackgroundTasks"
>;

/**
 * When T3 checks in on a quiet thread's waits, or null when it won't: the user settled or stopped
 * the thread, it asks the user something, or a usage limit would fail the turn.
 */
export function threadWaitCheckIn(
  thread: WaitCheckInThread,
): { readonly at: DateTime.Utc; readonly waits: ReadonlyArray<PendingBackgroundWorkTask> } | null {
  if (
    thread.archivedAt !== null ||
    thread.deletedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.settledAt !== null ||
    isProviderNativeSubagentThread(thread) ||
    thread.activeRunId !== null ||
    thread.activityRunStatus != null ||
    thread.pendingRuntimeRequest !== null ||
    thread.latestRunStopRequested === true ||
    thread.lastErrorClass === "usage_limit"
  ) {
    return null;
  }
  const waits = (thread.pendingBackgroundTasks ?? []).filter(taskHoldsCompletion);
  const at = waitCheckInAt({ quietSince: thread.latestRunCompletedAt, tasks: waits });
  return at === null ? null : { at, waits };
}

/**
 * At the agent's stated time, or after the thread has been quiet as long as the wait has been
 * open, from 30 minutes up to 4 hours, so a long wait is checked less often without stored history.
 */
function waitCheckInAt(input: {
  readonly quietSince: DateTime.Utc | null | undefined;
  readonly tasks: ReadonlyArray<
    Pick<PendingBackgroundWorkTask, "kind" | "awaited" | "startedAt" | "expectedBy">
  >;
}): DateTime.Utc | null {
  if (input.quietSince == null) return null;
  const quietMs = DateTime.toEpochMillis(input.quietSince);
  let dueMs: number | null = null;
  for (const task of input.tasks) {
    if (!taskHoldsCompletion(task)) continue;
    const expectedMs = parseIsoMillis(task.expectedBy);
    const startedMs = parseIsoMillis(task.startedAt) ?? quietMs;
    // A wait that began after the thread went quiet, such as a watch the user started, counts from its start.
    const fromMs = Math.max(quietMs, startedMs);
    const taskDueMs =
      expectedMs !== null && expectedMs > fromMs
        ? expectedMs
        : fromMs +
          Math.min(WAIT_CHECK_IN_MAX_MS, Math.max(WAIT_CHECK_IN_MIN_MS, fromMs - startedMs));
    dueMs = dueMs === null ? taskDueMs : Math.min(dueMs, taskDueMs);
  }
  return dueMs === null ? null : DateTime.makeUnsafe(dueMs);
}

function parseIsoMillis(value: string | undefined): number | null {
  if (value === undefined) return null;
  const millis = Date.parse(value);
  return Number.isNaN(millis) ? null : millis;
}

function pullRequestWatchTasks(
  pullRequests: ReadonlyArray<PendingBackgroundWorkPullRequest> | undefined,
): Array<PendingBackgroundWorkTask> {
  return (pullRequests ?? []).flatMap((link) =>
    // A merged PR's watch still holds: the reactor wakes the agent once when it ends it.
    link.watch === undefined || link.source === "stack-dismissed"
      ? []
      : [
          {
            // Links store their normalized identity, and this id only has to be unique within the
            // thread, so it reads those fields instead of parsing the URL.
            taskId: `pull-request-watch:${link.host.toLowerCase()}/${link.repository.toLowerCase()}#${link.number}`,
            description: `Watching pull request #${link.number}`,
            kind: "monitor" as const,
            awaited: true as const,
            startedAt: link.watch.startedAt,
          },
        ],
  );
}
