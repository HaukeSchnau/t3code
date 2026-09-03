import {
  EnvironmentId,
  OrchestrationCoordinationShell,
  OrchestrationEffortShell,
  OrchestrationThreadRef,
  OrchestrationThreadRelationshipShell,
  OrchestrationWaitShell,
  OrchestrationWatchShell,
  ThreadId,
  TurnId,
  ThreadOrchestrationBatchId,
  ThreadOrchestrationEffortActivityPayload,
  ThreadOrchestrationEffortId,
  ThreadOrchestrationRelationship,
  ThreadOrchestrationWaitActivityPayload,
  ThreadOrchestrationWaitId,
  ThreadOrchestrationWatchActivityPayload,
  ThreadOrchestrationWatchId,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeRelationship = Schema.decodeUnknownOption(ThreadOrchestrationRelationship);
const decodeEffortActivity = Schema.decodeUnknownOption(ThreadOrchestrationEffortActivityPayload);
const decodeWaitActivity = Schema.decodeUnknownOption(ThreadOrchestrationWaitActivityPayload);
const decodeWatchActivity = Schema.decodeUnknownOption(ThreadOrchestrationWatchActivityPayload);

const BatchCreatedPayload = Schema.Struct({
  batchId: ThreadOrchestrationBatchId,
  coordinatorEnvironmentId: EnvironmentId,
  coordinatorThreadId: ThreadId,
  title: Schema.String,
  members: Schema.Array(
    Schema.Struct({
      label: Schema.String,
      environmentId: EnvironmentId,
      threadId: ThreadId,
    }),
  ),
  createdAt: Schema.String,
  deadlineAt: Schema.NullOr(Schema.String),
});
const decodeBatchCreated = Schema.decodeUnknownOption(BatchCreatedPayload);

const BatchLifecyclePayload = Schema.Struct({
  batchId: ThreadOrchestrationBatchId,
  status: Schema.optional(Schema.String),
});
const decodeBatchLifecycle = Schema.decodeUnknownOption(BatchLifecyclePayload);

function refKey(ref: OrchestrationThreadRef): string {
  return `${ref.environmentId ?? "local"}:${ref.threadId}`;
}

function relationshipKey(relationship: OrchestrationThreadRelationshipShell): string {
  return `${relationship.kind}:${refKey(relationship.actor)}:${refKey(relationship.target)}`;
}

/**
 * Rebuild the compact coordination read model from durable activities. The
 * activities remain the source of truth; this model is small enough to ship
 * with the shell without hydrating any transcript.
 */
export function deriveThreadCoordinationShell(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): OrchestrationCoordinationShell {
  const relationships = new Map<string, OrchestrationThreadRelationshipShell>();
  const efforts = new Map<ThreadOrchestrationEffortId, OrchestrationEffortShell>();
  const waits = new Map<ThreadOrchestrationWaitId, OrchestrationWaitShell>();
  const watches = new Map<ThreadOrchestrationWatchId, OrchestrationWatchShell>();
  const effortMemberLeftAt = new Map<string, string>();

  for (const activity of activities) {
    if (activity.kind === "thread-orchestration.relationship") {
      const decoded = decodeRelationship(activity.payload);
      if (Option.isNone(decoded)) continue;
      const relationship = decoded.value;
      if (
        relationship.kind !== "createdBy" &&
        relationship.kind !== "forkedFrom" &&
        relationship.kind !== "replaces"
      ) {
        continue;
      }
      const shell: OrchestrationThreadRelationshipShell = {
        kind: relationship.kind,
        actor: {
          ...(relationship.actorEnvironmentId === undefined
            ? {}
            : { environmentId: relationship.actorEnvironmentId }),
          threadId: relationship.actorThreadId,
        },
        target: {
          ...(relationship.targetEnvironmentId === undefined
            ? {}
            : { environmentId: relationship.targetEnvironmentId }),
          threadId: relationship.targetThreadId,
        },
        ...(relationship.label === undefined ? {} : { label: relationship.label }),
        ...(relationship.effortId === undefined ? {} : { effortId: relationship.effortId }),
        ...(relationship.launchTurnId === undefined
          ? {}
          : {
              launchTurnId:
                relationship.launchTurnId === null ? null : TurnId.make(relationship.launchTurnId),
            }),
        createdAt: relationship.createdAt,
      };
      relationships.set(relationshipKey(shell), shell);
      continue;
    }

    if (activity.kind.startsWith("thread-orchestration.effort.")) {
      const decoded = decodeEffortActivity(activity.payload);
      if (Option.isNone(decoded)) continue;
      const payload = decoded.value;
      if (payload.kind === "opened") {
        efforts.set(payload.effort.effortId, payload.effort);
        continue;
      }
      const current = efforts.get(payload.effortId);
      if (current === undefined) continue;
      switch (payload.kind) {
        case "renamed":
          efforts.set(payload.effortId, { ...current, title: payload.title });
          break;
        case "member-joined":
          efforts.set(payload.effortId, {
            ...current,
            members: [
              ...current.members.filter(
                (member) => refKey(member.thread) !== refKey(payload.member.thread),
              ),
              payload.member,
            ],
          });
          break;
        case "member-left":
          effortMemberLeftAt.set(
            `${payload.effortId}:${refKey(payload.thread)}`,
            activity.createdAt,
          );
          efforts.set(payload.effortId, {
            ...current,
            members: current.members.filter(
              (member) => refKey(member.thread) !== refKey(payload.thread),
            ),
          });
          break;
        case "closed":
          efforts.set(payload.effortId, { ...current, closedAt: payload.closedAt });
          break;
        case "reopened":
          efforts.set(payload.effortId, { ...current, closedAt: null });
          break;
      }
      continue;
    }

    if (activity.kind.startsWith("thread-orchestration.wait.")) {
      const decoded = decodeWaitActivity(activity.payload);
      if (Option.isNone(decoded)) continue;
      const payload = decoded.value;
      if (payload.kind === "opened") {
        waits.set(payload.wait.waitId, payload.wait);
        continue;
      }
      const current = waits.get(payload.waitId);
      if (current === undefined) continue;
      if (payload.kind === "attention") {
        waits.set(payload.waitId, {
          ...current,
          members: current.members.map((member) =>
            refKey(member.thread) === refKey(payload.member.thread) ? payload.member : member,
          ),
        });
      } else {
        waits.set(payload.waitId, {
          ...current,
          members: payload.members,
          state: payload.state,
          resolvedAt: payload.resolvedAt,
        });
      }
      continue;
    }

    if (activity.kind.startsWith("thread-orchestration.watch.")) {
      const decoded = decodeWatchActivity(activity.payload);
      if (Option.isNone(decoded)) continue;
      const payload = decoded.value;
      if (payload.kind === "opened") {
        watches.set(payload.watch.watchId, payload.watch);
        continue;
      }
      const current = watches.get(payload.watchId);
      if (current === undefined) continue;
      if (payload.kind === "started") {
        if (payload.generation <= current.generation) continue;
        watches.set(payload.watchId, { ...current, generation: payload.generation });
      } else if (payload.kind === "event") {
        if (payload.generation !== current.generation || payload.sequence <= current.lastSequence) {
          continue;
        }
        watches.set(payload.watchId, {
          ...current,
          lastSequence: payload.sequence,
          eventCount: current.eventCount + payload.events.length,
          lastEventAt: payload.observedAt,
          lastSummary: payload.summary,
        });
      } else {
        if (payload.generation !== current.generation) continue;
        watches.set(payload.watchId, {
          ...current,
          state: payload.state,
          closedAt: payload.closedAt,
        });
      }
      continue;
    }

    // Existing batches remain visible while agents migrate to independent
    // efforts and waits. This compatibility projection does not change their
    // persisted meaning.
    if (activity.kind === "thread-orchestration.batch.created") {
      const decoded = decodeBatchCreated(activity.payload);
      if (Option.isNone(decoded)) continue;
      const batch = decoded.value;
      const effortId = ThreadOrchestrationEffortId.make(batch.batchId);
      const waitId = ThreadOrchestrationWaitId.make(batch.batchId);
      const coordinator = {
        environmentId: batch.coordinatorEnvironmentId,
        threadId: batch.coordinatorThreadId,
      };
      efforts.set(effortId, {
        effortId,
        coordinator,
        title: batch.title,
        members: batch.members.map((member) => ({
          thread: { environmentId: member.environmentId, threadId: member.threadId },
          label: member.label,
          joinedAt: batch.createdAt,
        })),
        openedAt: batch.createdAt,
        closedAt: null,
      });
      waits.set(waitId, {
        waitId,
        coordinator,
        effortId,
        members: batch.members.map((member) => ({
          thread: { environmentId: member.environmentId, threadId: member.threadId },
          outcome: "unknown" as const,
        })),
        mode: "all",
        state: "open",
        openedAt: batch.createdAt,
        deadlineAt: batch.deadlineAt,
        resolvedAt: null,
      });
      continue;
    }

    if (activity.kind.startsWith("thread-orchestration.batch.")) {
      const decoded = decodeBatchLifecycle(activity.payload);
      if (Option.isNone(decoded)) continue;
      const waitId = ThreadOrchestrationWaitId.make(decoded.value.batchId);
      const effortId = ThreadOrchestrationEffortId.make(decoded.value.batchId);
      const wait = waits.get(waitId);
      const effort = efforts.get(effortId);
      if (wait === undefined) continue;
      const state =
        activity.kind === "thread-orchestration.batch.cancelled"
          ? ("cancelled" as const)
          : decoded.value.status === "deadline-exceeded"
            ? ("deadline-exceeded" as const)
            : activity.kind === "thread-orchestration.batch.settled"
              ? ("satisfied" as const)
              : null;
      if (state === null) continue;
      waits.set(waitId, { ...wait, state, resolvedAt: activity.createdAt });
      if (effort !== undefined) efforts.set(effortId, { ...effort, closedAt: activity.createdAt });
    }
  }

  // Creation relationships carry initial effort membership in the same
  // durable fact. The explicit member event remains supported for later adds,
  // labels, and removals.
  for (const relationship of relationships.values()) {
    if (
      relationship.kind !== "createdBy" ||
      relationship.effortId === undefined ||
      relationship.label === undefined
    ) {
      continue;
    }
    const effort = efforts.get(relationship.effortId);
    if (effort === undefined) continue;
    const memberKey = `${relationship.effortId}:${refKey(relationship.target)}`;
    const leftAt = effortMemberLeftAt.get(memberKey);
    if (leftAt !== undefined && leftAt >= relationship.createdAt) continue;
    if (effort.members.some((member) => refKey(member.thread) === refKey(relationship.target))) {
      continue;
    }
    efforts.set(relationship.effortId, {
      ...effort,
      members: [
        ...effort.members,
        {
          thread: relationship.target,
          label: relationship.label,
          joinedAt: relationship.createdAt,
        },
      ],
    });
  }

  return {
    relationships: [...relationships.values()].toSorted((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    ),
    efforts: [...efforts.values()].toSorted((a, b) => a.openedAt.localeCompare(b.openedAt)),
    waits: [...waits.values()].toSorted((a, b) => a.openedAt.localeCompare(b.openedAt)),
    watches: [...watches.values()].toSorted((a, b) => a.openedAt.localeCompare(b.openedAt)),
  };
}
