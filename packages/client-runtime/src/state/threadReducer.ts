import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import * as O from "effect/Order";
import type {
  MessageId,
  OrchestrationCheckpointSummary,
  OrchestrationEvent,
  OrchestrationLatestTurn,
  OrchestrationMessage,
  OrchestrationSession,
  OrchestrationThread,
  OrchestrationThreadActivity,
  OrchestrationThreadActivityDetailMode,
  OrchestrationThreadHistoricalActivityGroup,
  TurnId,
} from "@t3tools/contracts";

export type ThreadDetailReducerResult =
  | { readonly kind: "updated"; readonly thread: OrchestrationThread }
  | { readonly kind: "deleted" }
  | {
      readonly kind: "authoritative-refresh-required";
      readonly reason: "historical-activity-changed";
      readonly turnId: TurnId;
    }
  | { readonly kind: "unchanged" };

const proposedPlanOrder = O.combine<OrchestrationThread["proposedPlans"][number]>(
  O.mapInput(O.String, (p) => p.createdAt),
  O.mapInput(O.String, (p) => p.id),
);

const checkpointOrder = O.mapInput(
  O.Number,
  (cp: OrchestrationThread["checkpoints"][number]) =>
    cp.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER,
);

const queuedMessageOrder = O.combine<NonNullable<OrchestrationThread["queuedMessages"]>[number]>(
  O.mapInput(O.String, (message) => message.createdAt),
  O.mapInput(O.String, (message) => message.messageId),
);

type OrderedActivity = Pick<OrchestrationThreadActivity, "id" | "sequence" | "createdAt">;

function compareActivities(left: OrderedActivity, right: OrderedActivity): number {
  if (left.sequence === undefined && right.sequence !== undefined) return 1;
  if (left.sequence !== undefined && right.sequence === undefined) return -1;
  if (left.sequence !== undefined && right.sequence !== undefined) {
    const sequence = left.sequence - right.sequence;
    if (sequence !== 0) return sequence;
  }
  const createdAt = left.createdAt.localeCompare(right.createdAt);
  return createdAt !== 0 ? createdAt : left.id.localeCompare(right.id);
}

function activityProducesWorkLogRow(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind === "tool.started" || activity.kind === "task.started") return false;
  if (activity.kind === "context-window.updated") return false;
  if (activity.kind === "account.rate-limits.updated") return false;
  if (activity.kind === "subagent.thread") return false;
  if (activity.summary === "Checkpoint captured") return false;
  if (activity.kind !== "tool.updated" && activity.kind !== "tool.completed") return true;
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  return !(typeof payload?.detail === "string" && payload.detail.startsWith("ExitPlanMode:"));
}

function activityIsGloballyPromoted(activity: OrchestrationThreadActivity): boolean {
  return activity.kind === "turn.plan.updated" || activity.kind === "subagent.thread";
}

function activityPayloadBytes(activity: OrchestrationThreadActivity): number {
  try {
    return JSON.stringify(activity.payload)?.length ?? 0;
  } catch {
    return 0;
  }
}

function descriptorFromActivities(
  turnId: TurnId,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): OrchestrationThreadHistoricalActivityGroup | null {
  const firstActivity = activities[0];
  if (!firstActivity) return null;
  let revision = 0;
  let payloadBytes = 0;
  let displayActivityCount = 0;
  let firstDisplayActivity: OrchestrationThreadActivity | undefined;
  let lastDisplayActivity: OrchestrationThreadActivity | undefined;
  for (const activity of activities) {
    revision = Math.max(revision, activity.revision ?? 0);
    payloadBytes += activityPayloadBytes(activity);
    if (activityProducesWorkLogRow(activity)) {
      displayActivityCount += 1;
      firstDisplayActivity ??= activity;
      lastDisplayActivity = activity;
    }
  }
  // Match the server descriptor exactly: duration anchors describe visible
  // fold work, with canonical all-activity anchors only when every row is
  // hidden from the work log.
  const first = firstDisplayActivity ?? firstActivity;
  const last = lastDisplayActivity ?? activities.at(-1)!;
  return {
    turnId,
    revision,
    activityCount: activities.length,
    payloadBytes,
    displayActivityCount,
    firstActivityAt: first.createdAt,
    lastActivityAt: last.createdAt,
  };
}

function upsertHistoricalGroup(
  groups: ReadonlyArray<OrchestrationThreadHistoricalActivityGroup> | undefined,
  nextGroup: OrchestrationThreadHistoricalActivityGroup,
): OrchestrationThreadHistoricalActivityGroup[] {
  const next = [...(groups ?? []).filter((group) => group.turnId !== nextGroup.turnId), nextGroup];
  next.sort(
    (left, right) =>
      left.firstActivityAt.localeCompare(right.firstActivityAt) ||
      left.turnId.localeCompare(right.turnId),
  );
  return next;
}

function compactInactiveTurnActivities(
  thread: OrchestrationThread,
  latestTurn: OrchestrationLatestTurn | null,
  session: OrchestrationSession | null,
): Pick<OrchestrationThread, "activities" | "historicalActivityGroups"> {
  const hotTurnIds = new Set<TurnId>();
  if (latestTurn) hotTurnIds.add(latestTurn.turnId);
  if (session?.activeTurnId) hotTurnIds.add(session.activeTurnId);

  let historicalActivityGroups = [...(thread.historicalActivityGroups ?? [])];
  const activities: OrchestrationThreadActivity[] = [];
  const demotedByTurnId = new Map<TurnId, OrchestrationThreadActivity[]>();
  for (const activity of thread.activities) {
    if (
      activity.turnId === null ||
      hotTurnIds.has(activity.turnId) ||
      activityIsGloballyPromoted(activity)
    ) {
      activities.push(activity);
      continue;
    }
    const turnActivities = demotedByTurnId.get(activity.turnId) ?? [];
    turnActivities.push(activity);
    demotedByTurnId.set(activity.turnId, turnActivities);
  }
  for (const [turnId, turnActivities] of demotedByTurnId) {
    const descriptor = descriptorFromActivities(turnId, turnActivities);
    if (descriptor) {
      historicalActivityGroups = upsertHistoricalGroup(historicalActivityGroups, descriptor);
    }
  }
  return { activities, historicalActivityGroups };
}

function projectActivitiesForMode(
  thread: OrchestrationThread,
  latestTurn: OrchestrationLatestTurn | null,
  session: OrchestrationSession | null,
  activityDetailMode: OrchestrationThreadActivityDetailMode,
): Pick<OrchestrationThread, "activities" | "historicalActivityGroups"> {
  if (activityDetailMode === "compact") {
    return compactInactiveTurnActivities(thread, latestTurn, session);
  }
  return thread.historicalActivityGroups === undefined
    ? { activities: thread.activities }
    : {
        activities: thread.activities,
        historicalActivityGroups: thread.historicalActivityGroups,
      };
}

function activityTurnIsHot(thread: OrchestrationThread, turnId: TurnId): boolean {
  if (thread.latestTurn === null && thread.session?.activeTurnId == null) return true;
  return thread.latestTurn?.turnId === turnId || thread.session?.activeTurnId === turnId;
}

function insertOrderedActivity(
  activities: OrchestrationThreadActivity[],
  activity: OrchestrationThreadActivity,
): void {
  let low = 0;
  let high = activities.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (compareActivities(activities[middle]!, activity) <= 0) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  activities.splice(low, 0, activity);
}

function upsertOrderedActivity(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  activity: OrchestrationThreadActivity,
): OrchestrationThreadActivity[] {
  const lastIndex = activities.length - 1;
  const existingIndex =
    lastIndex >= 0 && activities[lastIndex]?.id === activity.id
      ? lastIndex
      : activities.findIndex((entry) => entry.id === activity.id);

  if (existingIndex >= 0) {
    const previous = activities[existingIndex - 1];
    const next = activities[existingIndex + 1];
    if (
      (previous === undefined || compareActivities(previous, activity) <= 0) &&
      (next === undefined || compareActivities(activity, next) <= 0)
    ) {
      const updated = [...activities];
      updated[existingIndex] = activity;
      return updated;
    }
    const reordered = [...activities];
    reordered.splice(existingIndex, 1);
    insertOrderedActivity(reordered, activity);
    return reordered;
  }

  const last = activities[lastIndex];
  if (last === undefined || compareActivities(last, activity) <= 0) {
    return [...activities, activity];
  }
  const inserted = [...activities];
  insertOrderedActivity(inserted, activity);
  return inserted;
}

/**
 * Matches the validity rule in `deriveLatestContextWindowSnapshot` (and the
 * server's snapshot-side `dropStaleContextWindowActivities`): rows without a
 * finite, non-negative `usedTokens` are skipped during the consumer's backward
 * walk, so they must not replace an earlier resolvable row here.
 */
function isResolvableContextWindowActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "context-window.updated") {
    return false;
  }
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  const usedTokens = payload?.usedTokens;
  return typeof usedTokens === "number" && Number.isFinite(usedTokens) && usedTokens >= 0;
}

/**
 * Apply a single orchestration event to an `OrchestrationThread`, returning
 * the updated thread, a deletion signal, or an "unchanged" marker when the
 * event doesn't affect this thread.
 *
 * This is a pure reducer operating on contract types. UI-specific mapping
 * (e.g. resolving attachment preview URLs, normalising model slugs, adding
 * scoped fields like `environmentId`) is the caller's responsibility.
 */
export function applyThreadDetailEvent(
  thread: OrchestrationThread,
  event: OrchestrationEvent,
  activityDetailMode: OrchestrationThreadActivityDetailMode = "full",
): ThreadDetailReducerResult {
  switch (event.type) {
    // ── Project events (irrelevant to thread detail) ────────────────
    case "project.created":
    case "project.meta-updated":
    case "project.deleted":
      return { kind: "unchanged" };

    // ── Thread lifecycle ────────────────────────────────────────────
    case "thread.created":
      return {
        kind: "updated",
        thread: {
          id: event.payload.threadId,
          projectId: event.payload.projectId,
          title: event.payload.title,
          modelSelection: event.payload.modelSelection,
          runtimeMode: event.payload.runtimeMode,
          interactionMode: event.payload.interactionMode,
          branch: event.payload.branch,
          worktreePath: event.payload.worktreePath,
          latestTurn: null,
          createdAt: event.payload.createdAt,
          updatedAt: event.payload.updatedAt,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          snoozedUntil: null,
          snoozedAt: null,
          deletedAt: null,
          messages: [],
          proposedPlans: [],
          activities: [],
          checkpoints: [],
          session: null,
        },
      };

    case "thread.deleted":
      return { kind: "deleted" };

    case "thread.archived":
      return {
        kind: "updated",
        thread: {
          ...thread,
          archivedAt: event.payload.archivedAt,
          titleRegeneration: null,
          updatedAt: event.payload.updatedAt,
        },
      };

    case "thread.unarchived":
      return {
        kind: "updated",
        thread: { ...thread, archivedAt: null, updatedAt: event.payload.updatedAt },
      };

    case "thread.settled":
      return {
        kind: "updated",
        thread: {
          ...thread,
          settledOverride: "settled",
          settledAt: event.payload.settledAt,
          updatedAt: event.payload.updatedAt,
        },
      };

    case "thread.unsettled":
      return {
        kind: "updated",
        thread: {
          ...thread,
          settledOverride: event.payload.reason === "user" ? "active" : null,
          settledAt: null,
          updatedAt: event.payload.updatedAt,
        },
      };

    case "thread.snoozed":
      return {
        kind: "updated",
        thread: {
          ...thread,
          snoozedUntil: event.payload.snoozedUntil,
          snoozedAt: event.payload.snoozedAt,
          updatedAt: event.payload.updatedAt,
        },
      };

    case "thread.unsnoozed":
      return {
        kind: "updated",
        thread: {
          ...thread,
          snoozedUntil: null,
          snoozedAt: null,
          updatedAt: event.payload.updatedAt,
        },
      };

    case "thread.pinned":
      return {
        kind: "updated",
        thread: {
          ...thread,
          pinnedAt: event.payload.pinnedAt,
          ...(event.payload.pinOrderKey !== undefined
            ? { pinOrderKey: event.payload.pinOrderKey }
            : {}),
          updatedAt: event.payload.updatedAt,
        },
      };

    case "thread.unpinned":
      return {
        kind: "updated",
        thread: {
          ...thread,
          pinnedAt: null,
          pinOrderKey: null,
          updatedAt: event.payload.updatedAt,
        },
      };

    case "thread.pin-reordered":
      return {
        kind: "updated",
        thread: {
          ...thread,
          pinOrderKey: event.payload.orderKey,
          updatedAt: event.payload.updatedAt,
        },
      };

    // ── Thread metadata ─────────────────────────────────────────────
    case "thread.meta-updated":
      return {
        kind: "updated",
        thread: {
          ...thread,
          ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
          ...(event.payload.titleRegeneration !== undefined
            ? { titleRegeneration: event.payload.titleRegeneration }
            : {}),
          ...(event.payload.modelSelection !== undefined
            ? { modelSelection: event.payload.modelSelection }
            : {}),
          ...(event.payload.branch !== undefined ? { branch: event.payload.branch } : {}),
          ...(event.payload.worktreePath !== undefined
            ? { worktreePath: event.payload.worktreePath }
            : {}),
          updatedAt: event.payload.updatedAt,
        },
      };

    case "thread.runtime-mode-set":
      return {
        kind: "updated",
        thread: {
          ...thread,
          runtimeMode: event.payload.runtimeMode,
          updatedAt: event.payload.updatedAt,
        },
      };

    case "thread.interaction-mode-set":
      return {
        kind: "updated",
        thread: {
          ...thread,
          interactionMode: event.payload.interactionMode,
          updatedAt: event.payload.updatedAt,
        },
      };

    // ── Queued messages ────────────────────────────────────────────
    case "thread.message-queued": {
      const queuedMessage = event.payload.queuedMessage;
      const queuedMessages = pipe(
        thread.queuedMessages ?? [],
        Arr.filter((entry) => entry.messageId !== queuedMessage.messageId),
        Arr.append(queuedMessage),
        Arr.sort(queuedMessageOrder),
      );

      return {
        kind: "updated",
        thread: {
          ...thread,
          queuedMessages,
          updatedAt: event.occurredAt,
        },
      };
    }

    case "thread.queued-message-deleted":
    case "thread.queued-message-dispatched": {
      const queuedMessages = pipe(
        thread.queuedMessages ?? [],
        Arr.filter((entry) => entry.messageId !== event.payload.messageId),
      );

      return {
        kind: "updated",
        thread: {
          ...thread,
          queuedMessages,
          updatedAt: event.occurredAt,
        },
      };
    }

    // ── Turn lifecycle ──────────────────────────────────────────────
    case "thread.turn-start-requested":
      return {
        kind: "updated",
        thread: {
          ...thread,
          ...(event.payload.modelSelection !== undefined
            ? { modelSelection: event.payload.modelSelection }
            : {}),
          runtimeMode: event.payload.runtimeMode,
          interactionMode: event.payload.interactionMode,
          updatedAt: event.occurredAt,
        },
      };

    case "thread.turn-interrupt-requested": {
      if (event.payload.turnId === undefined) {
        return { kind: "unchanged" };
      }
      const latestTurn = thread.latestTurn;
      if (latestTurn === null || latestTurn.turnId !== event.payload.turnId) {
        return { kind: "unchanged" };
      }
      return {
        kind: "updated",
        thread: {
          ...thread,
          latestTurn: {
            ...latestTurn,
            state: "interrupted",
            startedAt: latestTurn.startedAt ?? event.payload.createdAt,
            completedAt: latestTurn.completedAt ?? event.payload.createdAt,
          },
          updatedAt: event.occurredAt,
        },
      };
    }

    // ── Messages ────────────────────────────────────────────────────
    case "thread.message-sent": {
      const message: OrchestrationMessage = {
        id: event.payload.messageId,
        role: event.payload.role,
        text: event.payload.text,
        ...(event.payload.attachments !== undefined
          ? { attachments: event.payload.attachments }
          : {}),
        turnId: event.payload.turnId,
        streaming: event.payload.streaming,
        createdAt: event.payload.createdAt,
        updatedAt: event.payload.updatedAt,
      };

      const lastMessageIndex = thread.messages.length - 1;
      const existingMessageIndex =
        lastMessageIndex >= 0 && thread.messages[lastMessageIndex]?.id === message.id
          ? lastMessageIndex
          : thread.messages.findIndex((entry) => entry.id === message.id);
      const messages =
        existingMessageIndex < 0
          ? [...thread.messages, message]
          : (() => {
              const entry = thread.messages[existingMessageIndex]!;
              const updated = [...thread.messages];
              updated[existingMessageIndex] = {
                ...entry,
                text: message.streaming
                  ? `${entry.text}${message.text}`
                  : message.text.length > 0
                    ? message.text
                    : entry.text,
                streaming: message.streaming,
                ...(message.turnId !== undefined ? { turnId: message.turnId } : {}),
                ...(message.streaming ? {} : { updatedAt: message.updatedAt }),
                ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
              };
              return updated;
            })();
      // Update latestTurn for assistant messages bound to a turn. A completed
      // assistant message only settles the turn once the session is no longer
      // running it — providers may emit several assistant messages per turn
      // (commentary between tool calls), and the turn must stay unsettled
      // until the provider reports turn end.
      const turnStillRunning =
        event.payload.turnId !== null &&
        thread.session?.status === "running" &&
        thread.session.activeTurnId === event.payload.turnId;
      const settlesTurn = !event.payload.streaming && !turnStillRunning;
      const latestTurn: OrchestrationThread["latestTurn"] =
        event.payload.role === "assistant" &&
        event.payload.turnId !== null &&
        (thread.latestTurn === null || thread.latestTurn.turnId === event.payload.turnId)
          ? {
              turnId: event.payload.turnId,
              state: settlesTurn
                ? thread.latestTurn?.state === "interrupted"
                  ? "interrupted"
                  : thread.latestTurn?.state === "error"
                    ? "error"
                    : "completed"
                : "running",
              requestedAt:
                thread.latestTurn?.turnId === event.payload.turnId
                  ? thread.latestTurn.requestedAt
                  : event.payload.createdAt,
              startedAt:
                thread.latestTurn?.turnId === event.payload.turnId
                  ? (thread.latestTurn.startedAt ?? event.payload.createdAt)
                  : event.payload.createdAt,
              completedAt: settlesTurn
                ? event.payload.updatedAt
                : thread.latestTurn?.turnId === event.payload.turnId
                  ? (thread.latestTurn.completedAt ?? null)
                  : null,
              assistantMessageId: event.payload.messageId,
            }
          : thread.latestTurn;

      // Rebind checkpoint assistant message IDs for assistant messages.
      const checkpoints =
        event.payload.role === "assistant" && event.payload.turnId !== null
          ? rebindCheckpointAssistantMessage(
              thread.checkpoints,
              event.payload.turnId,
              event.payload.messageId,
            )
          : thread.checkpoints;
      const compacted = projectActivitiesForMode(
        thread,
        latestTurn,
        thread.session,
        activityDetailMode,
      );

      return {
        kind: "updated",
        thread: {
          ...thread,
          messages,
          checkpoints,
          latestTurn,
          ...compacted,
          updatedAt: event.occurredAt,
        },
      };
    }

    // ── Session ─────────────────────────────────────────────────────
    case "thread.session-set": {
      // Leaving the "running" session status is the turn-end signal: settle a
      // still-running latest turn so its duration reflects the whole turn.
      const settledTurnState = settledTurnStateForSessionStatus(event.payload.session.status);
      const latestTurn: OrchestrationLatestTurn | null =
        event.payload.session.status === "running" && event.payload.session.activeTurnId !== null
          ? {
              turnId: event.payload.session.activeTurnId,
              state: "running",
              requestedAt:
                thread.latestTurn?.turnId === event.payload.session.activeTurnId
                  ? thread.latestTurn.requestedAt
                  : event.payload.session.updatedAt,
              startedAt:
                thread.latestTurn?.turnId === event.payload.session.activeTurnId
                  ? (thread.latestTurn.startedAt ?? event.payload.session.updatedAt)
                  : event.payload.session.updatedAt,
              completedAt: null,
              assistantMessageId:
                thread.latestTurn?.turnId === event.payload.session.activeTurnId
                  ? thread.latestTurn.assistantMessageId
                  : null,
            }
          : thread.latestTurn !== null &&
              thread.latestTurn.state === "running" &&
              settledTurnState !== null
            ? {
                ...thread.latestTurn,
                state: settledTurnState,
                // A running turn's completedAt can only hold a mid-turn
                // placeholder checkpoint timestamp — the session leaving
                // "running" is the authoritative turn end.
                completedAt: event.payload.session.updatedAt,
              }
            : thread.latestTurn;
      const compacted = projectActivitiesForMode(
        thread,
        latestTurn,
        event.payload.session,
        activityDetailMode,
      );

      return {
        kind: "updated",
        thread: {
          ...thread,
          session: event.payload.session,
          latestTurn,
          ...compacted,
          updatedAt: event.occurredAt,
        },
      };
    }

    case "thread.session-stop-requested":
      return thread.session === null
        ? { kind: "unchanged" }
        : {
            kind: "updated",
            thread: {
              ...thread,
              session: {
                ...thread.session,
                status: "stopped",
                activeTurnId: null,
                updatedAt: event.payload.createdAt,
              },
              updatedAt: event.occurredAt,
            },
          };

    // ── Proposed plans ──────────────────────────────────────────────
    case "thread.proposed-plan-upserted": {
      const proposedPlan = event.payload.proposedPlan;

      const proposedPlans = pipe(
        thread.proposedPlans,
        Arr.filter((entry) => entry.id !== proposedPlan.id),
        Arr.append(proposedPlan),
        Arr.sort(proposedPlanOrder),
      );

      return {
        kind: "updated",
        thread: { ...thread, proposedPlans, updatedAt: event.occurredAt },
      };
    }

    // ── Checkpoints / turn diffs ────────────────────────────────────
    case "thread.turn-diff-completed": {
      const checkpoint: OrchestrationCheckpointSummary = {
        turnId: event.payload.turnId,
        checkpointTurnCount: event.payload.checkpointTurnCount,
        checkpointRef: event.payload.checkpointRef,
        status: event.payload.status,
        files: event.payload.files,
        assistantMessageId: event.payload.assistantMessageId,
        completedAt: event.payload.completedAt,
      };

      const existing = thread.checkpoints.find((entry) => entry.turnId === checkpoint.turnId);
      // Don't overwrite a non-missing checkpoint with a missing one.
      if (existing && existing.status !== "missing" && checkpoint.status === "missing") {
        return { kind: "unchanged" };
      }

      const checkpoints = pipe(
        thread.checkpoints,
        Arr.filter((entry) => entry.turnId !== checkpoint.turnId),
        Arr.append(checkpoint),
        Arr.sort(checkpointOrder),
      );

      // Mid-turn diff updates produce placeholder checkpoints; record the
      // checkpoint, but don't settle a turn its session is still running.
      const diffTurnStillRunning =
        thread.session?.status === "running" &&
        thread.session.activeTurnId === event.payload.turnId;
      const latestTurn =
        !diffTurnStillRunning &&
        (thread.latestTurn === null || thread.latestTurn.turnId === event.payload.turnId)
          ? {
              turnId: event.payload.turnId,
              state: checkpointStatusToTurnState(event.payload.status),
              requestedAt: thread.latestTurn?.requestedAt ?? event.payload.completedAt,
              startedAt: thread.latestTurn?.startedAt ?? event.payload.completedAt,
              completedAt: event.payload.completedAt,
              assistantMessageId: event.payload.assistantMessageId,
            }
          : thread.latestTurn;
      const compacted = projectActivitiesForMode(
        thread,
        latestTurn,
        thread.session,
        activityDetailMode,
      );

      return {
        kind: "updated",
        thread: {
          ...thread,
          checkpoints,
          latestTurn,
          ...compacted,
          updatedAt: event.occurredAt,
        },
      };
    }

    // ── Revert ──────────────────────────────────────────────────────
    case "thread.reverted": {
      const checkpoints = pipe(
        thread.checkpoints,
        Arr.filter(
          (entry) =>
            entry.checkpointTurnCount !== undefined &&
            entry.checkpointTurnCount <= event.payload.turnCount,
        ),
        Arr.sort(checkpointOrder),
      );

      const retainedTurnIds = new Set(Arr.map(checkpoints, (entry) => entry.turnId));
      const messages = retainMessagesAfterRevert(thread.messages, retainedTurnIds);
      const proposedPlans = pipe(
        thread.proposedPlans,
        Arr.filter((plan) => plan.turnId === null || retainedTurnIds.has(plan.turnId)),
      );
      const activities = pipe(
        thread.activities,
        Arr.filter((activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId)),
        Arr.map((activity) => ({ ...activity, revision: event.sequence })),
      );
      const historicalActivityGroups = (thread.historicalActivityGroups ?? [])
        .filter((group) => retainedTurnIds.has(group.turnId))
        .map((group) => ({ ...group, revision: event.sequence }));
      const latestCheckpoint = checkpoints.at(-1) ?? null;

      return {
        kind: "updated",
        thread: {
          ...thread,
          checkpoints,
          messages,
          proposedPlans,
          activities,
          historicalActivityGroups,
          latestTurn:
            latestCheckpoint === null
              ? null
              : {
                  turnId: latestCheckpoint.turnId,
                  state: checkpointStatusToTurnState(
                    latestCheckpoint.status as "ready" | "missing" | "error",
                  ),
                  requestedAt: latestCheckpoint.completedAt,
                  startedAt: latestCheckpoint.completedAt,
                  completedAt: latestCheckpoint.completedAt,
                  assistantMessageId: latestCheckpoint.assistantMessageId ?? null,
                },
          updatedAt: event.occurredAt,
        },
      };
    }

    case "thread.history-pruned": {
      const pruned = pruneMessagesFromHistoryTarget(thread.messages, event.payload.messageId);
      const messages = pruned?.messages ?? thread.messages;
      const prunedTurnIds = new Set<string>(event.payload.prunedTurnIds);
      const pruneFromCreatedAt = event.payload.pruneFromCreatedAt;
      const checkpoints = pipe(
        thread.checkpoints,
        Arr.filter((entry) => !prunedTurnIds.has(entry.turnId)),
        Arr.sort(checkpointOrder),
      );
      const proposedPlans = pipe(
        thread.proposedPlans,
        Arr.filter((plan) =>
          plan.turnId === null
            ? plan.createdAt < pruneFromCreatedAt
            : !prunedTurnIds.has(plan.turnId),
        ),
      );
      const activities = pipe(
        thread.activities,
        Arr.filter((activity) =>
          activity.turnId === null
            ? activity.createdAt < pruneFromCreatedAt
            : !prunedTurnIds.has(activity.turnId),
        ),
        Arr.map((activity) => ({ ...activity, revision: event.sequence })),
      );
      const historicalActivityGroups = (thread.historicalActivityGroups ?? [])
        .filter((group) => !prunedTurnIds.has(group.turnId))
        .map((group) => ({ ...group, revision: event.sequence }));
      const latestTurn =
        thread.latestTurn === null || !prunedTurnIds.has(thread.latestTurn.turnId)
          ? thread.latestTurn
          : null;

      return {
        kind: "updated",
        thread: {
          ...thread,
          checkpoints,
          messages,
          proposedPlans,
          activities,
          historicalActivityGroups,
          latestTurn,
          updatedAt: event.occurredAt,
        },
      };
    }

    // ── Activities ──────────────────────────────────────────────────
    case "thread.activity-appended": {
      const activity = { ...event.payload.activity, revision: event.sequence };
      const inactiveCompactTurn =
        activityDetailMode === "compact" &&
        activity.turnId !== null &&
        !activityTurnIsHot(thread, activity.turnId);
      const promotedActivityAlreadyHot =
        activityIsGloballyPromoted(activity) &&
        thread.activities.some((entry) => entry.id === activity.id);
      if (inactiveCompactTurn && !promotedActivityAlreadyHot) {
        // An inactive compact turn does not expose complete ID membership.
        // Persistence enforces immutable thread/turn membership, but the
        // client may still be behind the projection that establishes a new ID,
        // and a newly promoted ID may previously have been hidden. Only a
        // stable promoted ID already present hot is safe to update incrementally.
        return {
          kind: "authoritative-refresh-required",
          reason: "historical-activity-changed",
          turnId: activity.turnId!,
        };
      }
      const supersedesContextWindow = isResolvableContextWindowActivity(activity);
      const activityBase = thread.activities.filter(
        (entry) =>
          !(
            (activity.turnId === null &&
              activity.kind === "context-window.updated" &&
              entry.turnId === null &&
              entry.kind === "context-window.updated") ||
            (supersedesContextWindow &&
              entry.turnId === activity.turnId &&
              isResolvableContextWindowActivity(entry))
          ),
      );
      const activities = upsertOrderedActivity(activityBase, activity);

      return {
        kind: "updated",
        thread: { ...thread, activities, updatedAt: event.occurredAt },
      };
    }

    // ── Events that don't mutate thread state directly ──────────────
    case "thread.approval-response-requested":
    case "thread.user-input-response-requested":
    case "thread.checkpoint-revert-requested":
    case "thread.history-prune-requested":
      return { kind: "unchanged" };
  }

  // Forward-compatible: ignore unrecognized event types.
  return { kind: "unchanged" };
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Turn state to settle a still-running latest turn with when its session
 * leaves the "running" status, or null while the session is (re)starting or
 * running and the turn must stay unsettled.
 */
function settledTurnStateForSessionStatus(
  status: OrchestrationSession["status"],
): "completed" | "interrupted" | "error" | null {
  switch (status) {
    case "idle":
    case "ready":
      return "completed";
    case "error":
      return "error";
    case "interrupted":
    case "stopped":
      return "interrupted";
    case "starting":
    case "running":
      return null;
  }
}

function checkpointStatusToTurnState(
  status: "ready" | "missing" | "error",
): OrchestrationLatestTurn["state"] {
  switch (status) {
    case "ready":
      return "completed";
    case "error":
      return "error";
    case "missing":
      return "completed";
  }
}

function rebindCheckpointAssistantMessage(
  checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>,
  turnId: TurnId,
  messageId: MessageId,
): OrchestrationCheckpointSummary[] {
  return Arr.map(checkpoints, (entry) =>
    entry.turnId === turnId ? { ...entry, assistantMessageId: messageId } : entry,
  );
}

function retainMessagesAfterRevert(
  messages: ReadonlyArray<OrchestrationMessage>,
  retainedTurnIds: ReadonlySet<string>,
): OrchestrationMessage[] {
  // Keep messages that belong to a retained turn, plus system messages and
  // messages without a turn binding (pre-turn-0 user messages).
  return Arr.filter(messages, (message) => {
    if (message.role === "system") {
      return true;
    }
    if (message.turnId === null) {
      return true;
    }
    return retainedTurnIds.has(message.turnId);
  });
}

function pruneMessagesFromHistoryTarget(
  messages: ReadonlyArray<OrchestrationMessage>,
  messageId: MessageId,
): {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly prunedTurnIds: ReadonlySet<string>;
  readonly pruneFromCreatedAt: string;
} | null {
  const targetIndex = messages.findIndex(
    (message) => message.id === messageId && message.role === "user",
  );
  if (targetIndex < 0) {
    return null;
  }

  const prunedTurnIds = new Set<string>();
  const retainedMessages: OrchestrationMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === "system" || index < targetIndex) {
      retainedMessages.push(message);
      continue;
    }
    if (message.turnId !== null) {
      prunedTurnIds.add(message.turnId);
    }
  }

  return {
    messages: retainedMessages,
    prunedTurnIds,
    pruneFromCreatedAt: messages[targetIndex]!.createdAt,
  };
}
