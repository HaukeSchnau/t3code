import {
  EnvironmentId,
  EventId,
  ThreadId,
  ThreadOrchestrationEffortId,
  ThreadOrchestrationWaitId,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import { deriveThreadCoordinationShell } from "./ThreadCoordinationProjection.ts";

const coordinatorEnvironmentId = EnvironmentId.make("environment-1");
const coordinatorThreadId = ThreadId.make("thread-parent");
const workerThreadId = ThreadId.make("thread-worker");
const effortId = ThreadOrchestrationEffortId.make("effort-1");
const waitId = ThreadOrchestrationWaitId.make("wait-1");

const activity = (
  kind: string,
  payload: unknown,
  createdAt: string,
): OrchestrationThreadActivity => ({
  id: EventId.make(`${kind}:${createdAt}`),
  tone: "tool",
  kind,
  summary: kind,
  payload,
  turnId: null,
  createdAt,
});

it("reduces effort membership, relationships, and wait outcomes", () => {
  const openedAt = "2026-09-02T10:00:00.000Z";
  const joinedAt = "2026-09-02T10:00:01.000Z";
  const resolvedAt = "2026-09-02T10:00:02.000Z";
  const worker = { environmentId: coordinatorEnvironmentId, threadId: workerThreadId };
  const coordinator = {
    environmentId: coordinatorEnvironmentId,
    threadId: coordinatorThreadId,
  };

  const coordination = deriveThreadCoordinationShell([
    activity(
      "thread-orchestration.effort.opened",
      {
        kind: "opened",
        effort: {
          effortId,
          coordinator,
          title: "Review implementation",
          members: [],
          openedAt,
          closedAt: null,
        },
      },
      openedAt,
    ),
    activity(
      "thread-orchestration.relationship",
      {
        kind: "createdBy",
        actorEnvironmentId: coordinatorEnvironmentId,
        actorThreadId: coordinatorThreadId,
        targetEnvironmentId: coordinatorEnvironmentId,
        targetThreadId: workerThreadId,
        effortId,
        label: "Implementation",
        createdAt: joinedAt,
      },
      joinedAt,
    ),
    activity(
      "thread-orchestration.effort.member-joined",
      {
        kind: "member-joined",
        effortId,
        member: { thread: worker, label: "Implementation", joinedAt },
      },
      joinedAt,
    ),
    activity(
      "thread-orchestration.wait.opened",
      {
        kind: "opened",
        wait: {
          waitId,
          coordinator,
          effortId,
          members: [{ thread: worker, outcome: "unknown" }],
          mode: "all",
          state: "open",
          openedAt: joinedAt,
          deadlineAt: null,
          resolvedAt: null,
        },
      },
      joinedAt,
    ),
    activity(
      "thread-orchestration.wait.resolved",
      {
        kind: "resolved",
        waitId,
        state: "satisfied",
        members: [{ thread: worker, outcome: "completed" }],
        resolvedAt,
      },
      resolvedAt,
    ),
  ]);

  assert.strictEqual(coordination.relationships.length, 1);
  assert.deepStrictEqual(coordination.efforts[0]?.members, [
    { thread: worker, label: "Implementation", joinedAt },
  ]);
  assert.strictEqual(coordination.waits[0]?.state, "satisfied");
  assert.strictEqual(coordination.waits[0]?.members[0]?.outcome, "completed");
});

it("projects existing batches as compatibility efforts and waits", () => {
  const createdAt = "2026-09-02T11:00:00.000Z";
  const coordination = deriveThreadCoordinationShell([
    activity(
      "thread-orchestration.batch.created",
      {
        batchId: "batch-1",
        coordinatorEnvironmentId,
        coordinatorThreadId,
        title: "Two approaches",
        members: [
          {
            label: "Worker A",
            environmentId: coordinatorEnvironmentId,
            threadId: workerThreadId,
          },
        ],
        createdAt,
        deadlineAt: null,
      },
      createdAt,
    ),
  ]);

  assert.strictEqual(coordination.efforts[0]?.title, "Two approaches");
  assert.strictEqual(coordination.waits[0]?.state, "open");
});
