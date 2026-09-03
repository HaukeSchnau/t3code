import { describe, expect, it } from "vite-plus/test";

import {
  CheckpointRef,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import type { OrchestrationThread } from "@t3tools/contracts";

import { applyThreadDetailEvent } from "./threadReducer.ts";

const baseEventFields = {
  eventId: EventId.make("event-1"),
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
} as const;

const baseThread: OrchestrationThread = {
  id: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  title: "Test Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};

function makeQueuedMessage(input: {
  readonly messageId: string;
  readonly text: string;
  readonly createdAt: string;
  readonly updatedAt?: string;
}): NonNullable<OrchestrationThread["queuedMessages"]>[number] {
  return {
    messageId: MessageId.make(input.messageId),
    threadId: ThreadId.make("thread-1"),
    text: input.text,
    attachments: [],
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: input.createdAt,
    updatedAt: input.updatedAt ?? input.createdAt,
  };
}

describe("applyThreadDetailEvent", () => {
  describe("project events", () => {
    it("returns unchanged for project.created", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 1,
        occurredAt: "2026-04-01T01:00:00.000Z",
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-1"),
        type: "project.created",
        payload: {
          projectId: ProjectId.make("project-1"),
          title: "T3 Code",
          workspaceRoot: "/repo",
          repositoryIdentity: null,
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-04-01T01:00:00.000Z",
          updatedAt: "2026-04-01T01:00:00.000Z",
          deletedAt: null,
        },
      } as any);
      expect(result.kind).toBe("unchanged");
    });
  });

  describe("thread.created", () => {
    it("creates a fresh thread", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 1,
        occurredAt: "2026-04-01T01:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-2"),
        type: "thread.created",
        payload: {
          threadId: ThreadId.make("thread-2"),
          projectId: ProjectId.make("project-1"),
          title: "New Thread",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "main",
          worktreePath: null,
          createdAt: "2026-04-01T01:00:00.000Z",
          updatedAt: "2026-04-01T01:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.id).toBe("thread-2");
        expect(result.thread.title).toBe("New Thread");
        expect(result.thread.branch).toBe("main");
        expect(result.thread.messages).toEqual([]);
        expect(result.thread.session).toBeNull();
      }
    });
  });

  describe("thread.deleted", () => {
    it("returns deleted signal", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 2,
        occurredAt: "2026-04-01T02:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.deleted",
        payload: {
          threadId: ThreadId.make("thread-1"),
          deletedAt: "2026-04-01T02:00:00.000Z",
        },
      });
      expect(result.kind).toBe("deleted");
    });
  });

  describe("thread.archived / thread.unarchived", () => {
    it("sets archivedAt and clears title regeneration", () => {
      const regeneratingThread: OrchestrationThread = {
        ...baseThread,
        titleRegeneration: {
          requestId: CommandId.make("regenerate-title"),
          startedAt: "2026-04-01T02:00:00.000Z",
        },
      };
      const result = applyThreadDetailEvent(regeneratingThread, {
        ...baseEventFields,
        sequence: 3,
        occurredAt: "2026-04-01T03:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.archived",
        payload: {
          threadId: ThreadId.make("thread-1"),
          archivedAt: "2026-04-01T03:00:00.000Z",
          updatedAt: "2026-04-01T03:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.archivedAt).toBe("2026-04-01T03:00:00.000Z");
        expect(result.thread.titleRegeneration).toBeNull();
      }
    });

    it("clears archivedAt", () => {
      const archivedThread = { ...baseThread, archivedAt: "2026-04-01T03:00:00.000Z" };
      const result = applyThreadDetailEvent(archivedThread, {
        ...baseEventFields,
        sequence: 4,
        occurredAt: "2026-04-01T04:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.unarchived",
        payload: {
          threadId: ThreadId.make("thread-1"),
          updatedAt: "2026-04-01T04:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.archivedAt).toBeNull();
      }
    });
  });

  describe("thread.settled / thread.unsettled", () => {
    it("sets the settled override and timestamp", () => {
      const settledAt = "2026-04-01T05:00:00.000Z";
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 5,
        occurredAt: settledAt,
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.settled",
        payload: {
          threadId: ThreadId.make("thread-1"),
          settledAt,
          updatedAt: settledAt,
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.settledOverride).toBe("settled");
        expect(result.thread.settledAt).toBe(settledAt);
      }
    });

    it.each([
      ["user", "active"],
      ["activity", null],
    ] as const)("unsettles for %s with override %s", (reason, settledOverride) => {
      const settledThread: OrchestrationThread = {
        ...baseThread,
        settledOverride: "settled",
        settledAt: "2026-04-01T05:00:00.000Z",
      };
      const updatedAt = "2026-04-01T06:00:00.000Z";
      const result = applyThreadDetailEvent(settledThread, {
        ...baseEventFields,
        sequence: 6,
        occurredAt: updatedAt,
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.unsettled",
        payload: {
          threadId: ThreadId.make("thread-1"),
          reason,
          updatedAt,
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.settledOverride).toBe(settledOverride);
        expect(result.thread.settledAt).toBeNull();
      }
    });
  });

  describe("thread.pinned / thread.unpinned", () => {
    it("sets pinnedAt", () => {
      const pinnedAt = "2026-04-01T05:00:00.000Z";
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 5,
        occurredAt: pinnedAt,
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.pinned",
        payload: {
          threadId: ThreadId.make("thread-1"),
          pinnedAt,
          updatedAt: pinnedAt,
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.pinnedAt).toBe(pinnedAt);
      }
    });

    it("clears pinnedAt", () => {
      const pinnedThread: OrchestrationThread = {
        ...baseThread,
        pinnedAt: "2026-04-01T05:00:00.000Z",
      };
      const updatedAt = "2026-04-01T06:00:00.000Z";
      const result = applyThreadDetailEvent(pinnedThread, {
        ...baseEventFields,
        sequence: 6,
        occurredAt: updatedAt,
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.unpinned",
        payload: {
          threadId: ThreadId.make("thread-1"),
          updatedAt,
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.pinnedAt).toBeNull();
      }
    });
  });

  describe("thread.meta-updated", () => {
    it("patches title and branch", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 5,
        occurredAt: "2026-04-01T05:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.meta-updated",
        payload: {
          threadId: ThreadId.make("thread-1"),
          title: "Updated Title",
          branch: "feature/demo",
          updatedAt: "2026-04-01T05:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.title).toBe("Updated Title");
        expect(result.thread.branch).toBe("feature/demo");
        // Model selection should be unchanged since it wasn't in the payload
        expect(result.thread.modelSelection).toEqual(baseThread.modelSelection);
      }
    });

    it("sets and clears a linked pull request", () => {
      const linkedPullRequest = {
        projectId: ProjectId.make("project-1"),
        repository: "pingdotgg/t3code",
        number: 42,
        url: "https://github.com/pingdotgg/t3code/pull/42",
      };
      const linked = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 5,
        occurredAt: "2026-04-01T05:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.meta-updated",
        payload: {
          threadId: ThreadId.make("thread-1"),
          linkedPullRequest,
          updatedAt: "2026-04-01T05:00:00.000Z",
        },
      });

      expect(linked.kind).toBe("updated");
      if (linked.kind !== "updated") return;
      expect(linked.thread.linkedPullRequest).toEqual(linkedPullRequest);

      const cleared = applyThreadDetailEvent(linked.thread, {
        ...baseEventFields,
        sequence: 6,
        occurredAt: "2026-04-01T06:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.meta-updated",
        payload: {
          threadId: ThreadId.make("thread-1"),
          linkedPullRequest: null,
          updatedAt: "2026-04-01T06:00:00.000Z",
        },
      });

      expect(cleared.kind).toBe("updated");
      if (cleared.kind === "updated") {
        expect(cleared.thread.linkedPullRequest).toBeNull();
      }
    });
  });

  describe("queued messages", () => {
    it("adds queued messages from live events in display order", () => {
      const result = applyThreadDetailEvent(
        {
          ...baseThread,
          queuedMessages: [
            makeQueuedMessage({
              messageId: "msg-queued-2",
              text: "Second queued message",
              createdAt: "2026-04-01T06:02:00.000Z",
            }),
          ],
        },
        {
          ...baseEventFields,
          sequence: 6,
          occurredAt: "2026-04-01T06:03:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.message-queued",
          payload: {
            threadId: ThreadId.make("thread-1"),
            queuedMessage: makeQueuedMessage({
              messageId: "msg-queued-1",
              text: "First queued message",
              createdAt: "2026-04-01T06:01:00.000Z",
            }),
          },
        },
      );

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.queuedMessages?.map((message) => message.messageId)).toEqual([
          "msg-queued-1",
          "msg-queued-2",
        ]);
        expect(result.thread.queuedMessages?.[0]?.text).toBe("First queued message");
        expect(result.thread.updatedAt).toBe("2026-04-01T06:03:00.000Z");
      }
    });

    it("replaces an existing queued message with the same id", () => {
      const result = applyThreadDetailEvent(
        {
          ...baseThread,
          queuedMessages: [
            makeQueuedMessage({
              messageId: "msg-queued-1",
              text: "Draft text",
              createdAt: "2026-04-01T06:01:00.000Z",
            }),
          ],
        },
        {
          ...baseEventFields,
          sequence: 7,
          occurredAt: "2026-04-01T06:04:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.message-queued",
          payload: {
            threadId: ThreadId.make("thread-1"),
            queuedMessage: makeQueuedMessage({
              messageId: "msg-queued-1",
              text: "Updated text",
              createdAt: "2026-04-01T06:01:00.000Z",
              updatedAt: "2026-04-01T06:04:00.000Z",
            }),
          },
        },
      );

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.queuedMessages).toHaveLength(1);
        expect(result.thread.queuedMessages?.[0]?.text).toBe("Updated text");
      }
    });

    it("removes queued messages after delete and dispatch events", () => {
      const threadWithQueuedMessages: OrchestrationThread = {
        ...baseThread,
        queuedMessages: [
          makeQueuedMessage({
            messageId: "msg-queued-1",
            text: "Delete me",
            createdAt: "2026-04-01T06:01:00.000Z",
          }),
          makeQueuedMessage({
            messageId: "msg-queued-2",
            text: "Dispatch me",
            createdAt: "2026-04-01T06:02:00.000Z",
          }),
        ],
      };

      const afterDelete = applyThreadDetailEvent(threadWithQueuedMessages, {
        ...baseEventFields,
        sequence: 8,
        occurredAt: "2026-04-01T06:05:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.queued-message-deleted",
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("msg-queued-1"),
          deletedAt: "2026-04-01T06:05:00.000Z",
        },
      });

      expect(afterDelete.kind).toBe("updated");
      if (afterDelete.kind !== "updated") {
        return;
      }
      expect(afterDelete.thread.queuedMessages?.map((message) => message.messageId)).toEqual([
        "msg-queued-2",
      ]);

      const afterDispatch = applyThreadDetailEvent(afterDelete.thread, {
        ...baseEventFields,
        sequence: 9,
        occurredAt: "2026-04-01T06:06:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.queued-message-dispatched",
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("msg-queued-2"),
          dispatchedAt: "2026-04-01T06:06:00.000Z",
        },
      });

      expect(afterDispatch.kind).toBe("updated");
      if (afterDispatch.kind === "updated") {
        expect(afterDispatch.thread.queuedMessages).toEqual([]);
      }
    });
  });

  describe("thread.message-sent", () => {
    it("appends a new message", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 10,
        occurredAt: "2026-04-01T06:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.message-sent",
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("msg-1"),
          role: "user",
          text: "Hello, world!",
          turnId: null,
          streaming: false,
          createdAt: "2026-04-01T06:00:00.000Z",
          updatedAt: "2026-04-01T06:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.messages).toHaveLength(1);
        expect(result.thread.messages[0]?.text).toBe("Hello, world!");
      }
    });

    it("appends text for streaming messages", () => {
      const threadWithMessage: OrchestrationThread = {
        ...baseThread,
        messages: [
          {
            id: MessageId.make("msg-2"),
            role: "assistant",
            text: "Hello",
            turnId: TurnId.make("turn-1"),
            streaming: true,
            createdAt: "2026-04-01T06:00:00.000Z",
            updatedAt: "2026-04-01T06:00:00.000Z",
          },
        ],
      };

      const result = applyThreadDetailEvent(threadWithMessage, {
        ...baseEventFields,
        sequence: 7,
        occurredAt: "2026-04-01T06:01:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.message-sent",
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("msg-2"),
          role: "assistant",
          text: ", world!",
          turnId: TurnId.make("turn-1"),
          streaming: true,
          createdAt: "2026-04-01T06:00:00.000Z",
          updatedAt: "2026-04-01T06:01:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.messages).toHaveLength(1);
        expect(result.thread.messages[0]?.text).toBe("Hello, world!");
      }
    });

    it("updates latestTurn for assistant messages with a turn", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 8,
        occurredAt: "2026-04-01T07:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.message-sent",
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("msg-3"),
          role: "assistant",
          text: "Done.",
          turnId: TurnId.make("turn-1"),
          streaming: false,
          createdAt: "2026-04-01T07:00:00.000Z",
          updatedAt: "2026-04-01T07:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.latestTurn?.turnId).toBe("turn-1");
        expect(result.thread.latestTurn?.state).toBe("completed");
        expect(result.thread.latestTurn?.assistantMessageId).toBe("msg-3");
      }
    });

    it("keeps latestTurn running for interim assistant messages while the session runs the turn", () => {
      const threadWithRunningSession: OrchestrationThread = {
        ...baseThread,
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "claude",
          runtimeMode: "full-access",
          activeTurnId: TurnId.make("turn-1"),
          lastError: null,
          updatedAt: "2026-04-01T06:59:00.000Z",
        },
        latestTurn: {
          turnId: TurnId.make("turn-1"),
          state: "running",
          requestedAt: "2026-04-01T06:59:00.000Z",
          startedAt: "2026-04-01T06:59:00.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      };

      const result = applyThreadDetailEvent(threadWithRunningSession, {
        ...baseEventFields,
        sequence: 8,
        occurredAt: "2026-04-01T07:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.message-sent",
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("msg-3"),
          role: "assistant",
          text: "Interim commentary between tool calls.",
          turnId: TurnId.make("turn-1"),
          streaming: false,
          createdAt: "2026-04-01T07:00:00.000Z",
          updatedAt: "2026-04-01T07:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.latestTurn?.state).toBe("running");
        expect(result.thread.latestTurn?.completedAt).toBeNull();
      }
    });
  });

  describe("thread.session-set", () => {
    it("bulk-demotes many activities into one constant-size descriptor per turn", () => {
      const previousTurnId = TurnId.make("turn-previous");
      const activities = Array.from({ length: 100 }, (_, index) => ({
        id: EventId.make(`bulk-${index}`),
        tone: "tool" as const,
        kind: "tool.completed",
        summary: `Tool ${index}`,
        payload: { output: "x".repeat(100) },
        turnId: previousTurnId,
        revision: index + 1,
        sequence: index + 1,
        createdAt: `2026-04-01T07:${String(index % 60).padStart(2, "0")}:00.000Z`,
      }));
      const thread: OrchestrationThread = {
        ...baseThread,
        latestTurn: {
          turnId: previousTurnId,
          state: "completed",
          requestedAt: activities[0]!.createdAt,
          startedAt: activities[0]!.createdAt,
          completedAt: activities.at(-1)!.createdAt,
          assistantMessageId: null,
        },
        activities,
      };

      const result = applyThreadDetailEvent(
        thread,
        {
          ...baseEventFields,
          sequence: 101,
          occurredAt: "2026-04-01T09:00:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.session-set",
          payload: {
            threadId: ThreadId.make("thread-1"),
            session: {
              threadId: ThreadId.make("thread-1"),
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: TurnId.make("turn-current"),
              lastError: null,
              updatedAt: "2026-04-01T09:00:00.000Z",
            },
          },
        },
        "compact",
      );

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.activities).toEqual([]);
        expect(result.thread.historicalActivityGroups).toHaveLength(1);
        expect(result.thread.historicalActivityGroups?.[0]).toMatchObject({
          turnId: previousTurnId,
          revision: 100,
          activityCount: 100,
          displayActivityCount: 100,
        });
        expect("activities" in (result.thread.historicalActivityGroups?.[0] ?? {})).toBe(false);
      }
    });

    it("anchors descriptors to displayable work with an all-hidden canonical fallback", () => {
      const visibleTurnId = TurnId.make("turn-visible-anchor");
      const hiddenTurnId = TurnId.make("turn-hidden-anchor");
      const activities = [
        {
          id: EventId.make("visible-hidden-first"),
          tone: "tool" as const,
          kind: "task.started",
          summary: "Hidden start",
          payload: {},
          turnId: visibleTurnId,
          sequence: 1,
          createdAt: "2026-04-01T07:00:00.000Z",
        },
        {
          id: EventId.make("visible-row"),
          tone: "tool" as const,
          kind: "tool.completed",
          summary: "Visible work",
          payload: {},
          turnId: visibleTurnId,
          sequence: 2,
          createdAt: "2026-04-01T07:01:00.000Z",
        },
        {
          id: EventId.make("visible-hidden-last"),
          tone: "info" as const,
          kind: "context-window.updated",
          summary: "Hidden context",
          payload: {},
          turnId: visibleTurnId,
          sequence: 3,
          createdAt: "2026-04-01T07:02:00.000Z",
        },
        {
          id: EventId.make("all-hidden-first"),
          tone: "tool" as const,
          kind: "task.started",
          summary: "Hidden first",
          payload: {},
          turnId: hiddenTurnId,
          sequence: 4,
          createdAt: "2026-04-01T08:00:00.000Z",
        },
        {
          id: EventId.make("all-hidden-last"),
          tone: "tool" as const,
          kind: "tool.started",
          summary: "Hidden last",
          payload: {},
          turnId: hiddenTurnId,
          sequence: 5,
          createdAt: "2026-04-01T08:02:00.000Z",
        },
      ];
      const result = applyThreadDetailEvent(
        { ...baseThread, activities },
        {
          ...baseEventFields,
          sequence: 9,
          occurredAt: "2026-04-01T09:00:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.session-set",
          payload: {
            threadId: ThreadId.make("thread-1"),
            session: {
              threadId: ThreadId.make("thread-1"),
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: TurnId.make("turn-current"),
              lastError: null,
              updatedAt: "2026-04-01T09:00:00.000Z",
            },
          },
        },
        "compact",
      );

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(
          result.thread.historicalActivityGroups?.find((group) => group.turnId === visibleTurnId),
        ).toMatchObject({
          displayActivityCount: 1,
          firstActivityAt: "2026-04-01T07:01:00.000Z",
          lastActivityAt: "2026-04-01T07:01:00.000Z",
        });
        expect(
          result.thread.historicalActivityGroups?.find((group) => group.turnId === hiddenTurnId),
        ).toMatchObject({
          displayActivityCount: 0,
          firstActivityAt: "2026-04-01T08:00:00.000Z",
          lastActivityAt: "2026-04-01T08:02:00.000Z",
        });
      }
    });

    it("demotes the previous hot turn to payload-free history when a new turn starts", () => {
      const previousTurnId = TurnId.make("turn-previous");
      const globalActivity = {
        id: EventId.make("activity-global"),
        tone: "info" as const,
        kind: "global",
        summary: "Global state",
        payload: { keep: true },
        turnId: null,
        sequence: 1,
        createdAt: "2026-04-01T07:00:00.000Z",
      };
      const previousActivity = {
        id: EventId.make("activity-previous"),
        tone: "tool" as const,
        kind: "tool.completed",
        summary: "Large historical tool result",
        payload: { transcript: "large" },
        turnId: previousTurnId,
        sequence: 2,
        createdAt: "2026-04-01T07:01:00.000Z",
      };
      const thread: OrchestrationThread = {
        ...baseThread,
        latestTurn: {
          turnId: previousTurnId,
          state: "completed",
          requestedAt: previousActivity.createdAt,
          startedAt: previousActivity.createdAt,
          completedAt: previousActivity.createdAt,
          assistantMessageId: null,
        },
        activities: [globalActivity, previousActivity],
      };

      const result = applyThreadDetailEvent(
        thread,
        {
          ...baseEventFields,
          sequence: 9,
          occurredAt: "2026-04-01T08:00:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.session-set",
          payload: {
            threadId: ThreadId.make("thread-1"),
            session: {
              threadId: ThreadId.make("thread-1"),
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: TurnId.make("turn-current"),
              lastError: null,
              updatedAt: "2026-04-01T08:00:00.000Z",
            },
          },
        },
        "compact",
      );

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.activities).toEqual([globalActivity]);
        expect(result.thread.historicalActivityGroups).toEqual([
          {
            turnId: previousTurnId,
            revision: 0,
            activityCount: 1,
            payloadBytes: JSON.stringify(previousActivity.payload).length,
            displayActivityCount: 1,
            firstActivityAt: previousActivity.createdAt,
            lastActivityAt: previousActivity.createdAt,
          },
        ]);
        expect(JSON.stringify(result.thread.historicalActivityGroups)).not.toContain("large");
      }
    });

    it("never compacts completed turns in full activity mode", () => {
      const previousTurnId = TurnId.make("turn-previous-full");
      const previousActivity = {
        id: EventId.make("activity-previous-full"),
        tone: "tool" as const,
        kind: "tool.completed",
        summary: "Full historical result",
        payload: { transcript: "retain me" },
        turnId: previousTurnId,
        sequence: 2,
        createdAt: "2026-04-01T07:01:00.000Z",
      };
      const thread: OrchestrationThread = {
        ...baseThread,
        latestTurn: {
          turnId: previousTurnId,
          state: "completed",
          requestedAt: previousActivity.createdAt,
          startedAt: previousActivity.createdAt,
          completedAt: previousActivity.createdAt,
          assistantMessageId: null,
        },
        activities: [previousActivity],
      };

      const result = applyThreadDetailEvent(
        thread,
        {
          ...baseEventFields,
          sequence: 9,
          occurredAt: "2026-04-01T08:00:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.session-set",
          payload: {
            threadId: ThreadId.make("thread-1"),
            session: {
              threadId: ThreadId.make("thread-1"),
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: TurnId.make("turn-current"),
              lastError: null,
              updatedAt: "2026-04-01T08:00:00.000Z",
            },
          },
        },
        "full",
      );

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.activities).toEqual([previousActivity]);
        expect(result.thread.historicalActivityGroups).toBeUndefined();
      }
    });

    it("keeps plan and subagent activities globally hot in compact mode", () => {
      const previousTurnId = TurnId.make("turn-previous-promoted");
      const activities = [
        {
          id: EventId.make("foldable-command"),
          tone: "tool" as const,
          kind: "tool.completed",
          summary: "Historical command",
          payload: {},
          turnId: previousTurnId,
          sequence: 1,
          createdAt: "2026-04-01T07:00:00.000Z",
        },
        {
          id: EventId.make("promoted-plan"),
          tone: "info" as const,
          kind: "turn.plan.updated",
          summary: "Updated plan",
          payload: {},
          turnId: previousTurnId,
          sequence: 2,
          createdAt: "2026-04-01T07:01:00.000Z",
        },
        {
          id: EventId.make("promoted-subagent"),
          tone: "info" as const,
          kind: "subagent.thread",
          summary: "Subagent",
          payload: {},
          turnId: previousTurnId,
          sequence: 3,
          createdAt: "2026-04-01T07:02:00.000Z",
        },
      ];
      const thread: OrchestrationThread = {
        ...baseThread,
        latestTurn: {
          turnId: previousTurnId,
          state: "completed",
          requestedAt: activities[0]!.createdAt,
          startedAt: activities[0]!.createdAt,
          completedAt: activities.at(-1)!.createdAt,
          assistantMessageId: null,
        },
        activities,
      };

      const result = applyThreadDetailEvent(
        thread,
        {
          ...baseEventFields,
          sequence: 9,
          occurredAt: "2026-04-01T08:00:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.session-set",
          payload: {
            threadId: ThreadId.make("thread-1"),
            session: {
              threadId: ThreadId.make("thread-1"),
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: TurnId.make("turn-current"),
              lastError: null,
              updatedAt: "2026-04-01T08:00:00.000Z",
            },
          },
        },
        "compact",
      );

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.activities.map((activity) => activity.id)).toEqual([
          "promoted-plan",
          "promoted-subagent",
        ]);
        expect(result.thread.historicalActivityGroups?.[0]).toMatchObject({
          activityCount: 1,
          displayActivityCount: 1,
        });
      }
    });

    it("settles a running latestTurn when the session leaves the running status", () => {
      const threadWithRunningTurn: OrchestrationThread = {
        ...baseThread,
        latestTurn: {
          turnId: TurnId.make("turn-1"),
          state: "running",
          requestedAt: "2026-04-01T07:00:00.000Z",
          startedAt: "2026-04-01T07:00:00.000Z",
          completedAt: null,
          assistantMessageId: MessageId.make("msg-3"),
        },
      };

      const result = applyThreadDetailEvent(threadWithRunningTurn, {
        ...baseEventFields,
        sequence: 9,
        occurredAt: "2026-04-01T08:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.session-set",
        payload: {
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "ready",
            providerName: "claude",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-04-01T08:00:00.000Z",
          },
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.latestTurn?.state).toBe("completed");
        expect(result.thread.latestTurn?.completedAt).toBe("2026-04-01T08:00:00.000Z");
      }
    });

    it("updates session and latestTurn for a running session", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 9,
        occurredAt: "2026-04-01T08:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.session-set",
        payload: {
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: TurnId.make("turn-1"),
            lastError: null,
            updatedAt: "2026-04-01T08:00:00.000Z",
          },
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.session?.status).toBe("running");
        expect(result.thread.latestTurn?.turnId).toBe("turn-1");
        expect(result.thread.latestTurn?.state).toBe("running");
      }
    });
  });

  describe("thread.session-stop-requested", () => {
    it("marks session as stopped", () => {
      const threadWithSession: OrchestrationThread = {
        ...baseThread,
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: TurnId.make("turn-1"),
          lastError: null,
          updatedAt: "2026-04-01T08:00:00.000Z",
        },
      };

      const result = applyThreadDetailEvent(threadWithSession, {
        ...baseEventFields,
        sequence: 10,
        occurredAt: "2026-04-01T09:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.session-stop-requested",
        payload: {
          threadId: ThreadId.make("thread-1"),
          createdAt: "2026-04-01T09:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.session?.status).toBe("stopped");
        expect(result.thread.session?.activeTurnId).toBeNull();
      }
    });

    it("returns unchanged when no session exists", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 10,
        occurredAt: "2026-04-01T09:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.session-stop-requested",
        payload: {
          threadId: ThreadId.make("thread-1"),
          createdAt: "2026-04-01T09:00:00.000Z",
        },
      });
      expect(result.kind).toBe("unchanged");
    });
  });

  describe("thread.proposed-plan-upserted", () => {
    it("adds a proposed plan", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 11,
        occurredAt: "2026-04-01T10:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.proposed-plan-upserted",
        payload: {
          threadId: ThreadId.make("thread-1"),
          proposedPlan: {
            id: "plan-1",
            turnId: TurnId.make("turn-1"),
            planMarkdown: "## Plan\n- Do stuff",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-04-01T10:00:00.000Z",
            updatedAt: "2026-04-01T10:00:00.000Z",
          },
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.proposedPlans).toHaveLength(1);
        expect(result.thread.proposedPlans[0]?.id).toBe("plan-1");
      }
    });
  });

  describe("thread.activity-appended", () => {
    it("keeps sequenced activities before NULL-sequence activities", () => {
      const unsequenced = {
        id: EventId.make("activity-unsequenced"),
        tone: "tool" as const,
        kind: "tool.completed",
        summary: "Legacy activity",
        payload: {},
        turnId: TurnId.make("turn-1"),
        createdAt: "2026-04-01T10:00:00.000Z",
      };
      const result = applyThreadDetailEvent(
        { ...baseThread, activities: [unsequenced] },
        {
          ...baseEventFields,
          sequence: 12,
          occurredAt: "2026-04-01T11:00:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.activity-appended",
          payload: {
            threadId: ThreadId.make("thread-1"),
            activity: {
              ...unsequenced,
              id: EventId.make("activity-sequenced"),
              sequence: 4,
            },
          },
        },
      );

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.activities.map((activity) => activity.id)).toEqual([
          "activity-sequenced",
          "activity-unsequenced",
        ]);
      }
    });

    it("replaces the previous null-turn context snapshot without collapsing rate limits", () => {
      const priorContext = {
        id: EventId.make("context-old"),
        tone: "info" as const,
        kind: "context-window.updated",
        summary: "Old context",
        payload: { usedTokens: 1 },
        turnId: null,
        sequence: 1,
        createdAt: "2026-04-01T10:00:00.000Z",
      };
      const rateLimit = {
        id: EventId.make("rate-limit"),
        tone: "info" as const,
        kind: "account.rate-limits.updated",
        summary: "Rate limits",
        payload: { primary: { usedPercent: 20 } },
        turnId: null,
        sequence: 2,
        createdAt: "2026-04-01T10:01:00.000Z",
      };
      const result = applyThreadDetailEvent(
        { ...baseThread, activities: [priorContext, rateLimit] },
        {
          ...baseEventFields,
          sequence: 12,
          occurredAt: "2026-04-01T11:00:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.activity-appended",
          payload: {
            threadId: ThreadId.make("thread-1"),
            activity: {
              ...priorContext,
              id: EventId.make("context-new"),
              summary: "New context",
              payload: { usedTokens: 2 },
              sequence: 3,
              createdAt: "2026-04-01T11:00:00.000Z",
            },
          },
        },
      );

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.activities.map((entry) => entry.id)).toEqual([
          "rate-limit",
          "context-new",
        ]);
      }
    });

    it("refreshes an unknown inactive compact destination instead of guessing membership", () => {
      const historicalTurnId = TurnId.make("turn-history");
      const result = applyThreadDetailEvent(
        {
          ...baseThread,
          latestTurn: {
            turnId: TurnId.make("turn-current"),
            state: "running",
            requestedAt: "2026-04-01T11:00:00.000Z",
            startedAt: "2026-04-01T11:00:00.000Z",
            completedAt: null,
            assistantMessageId: null,
          },
        },
        {
          ...baseEventFields,
          sequence: 12,
          occurredAt: "2026-04-01T11:00:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.activity-appended",
          payload: {
            threadId: ThreadId.make("thread-1"),
            activity: {
              id: EventId.make("activity-history"),
              tone: "tool",
              kind: "tool.completed",
              summary: "Historical command",
              payload: { output: "must not persist" },
              turnId: historicalTurnId,
              sequence: 11,
              createdAt: "2026-04-01T10:00:00.000Z",
            },
          },
        },
        "compact",
      );

      expect(result).toEqual({
        kind: "authoritative-refresh-required",
        reason: "historical-activity-changed",
        turnId: historicalTurnId,
      });
    });

    it("requests an authoritative compact refresh for a new eligible historical activity", () => {
      const historicalTurnId = TurnId.make("turn-history");
      const thread: OrchestrationThread = {
        ...baseThread,
        latestTurn: {
          turnId: TurnId.make("turn-current"),
          state: "running",
          requestedAt: "2026-04-01T11:00:00.000Z",
          startedAt: "2026-04-01T11:00:00.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
        historicalActivityGroups: [
          {
            turnId: historicalTurnId,
            revision: 10,
            activityCount: 8,
            payloadBytes: 4_096,
            displayActivityCount: 3,
            firstActivityAt: "2026-04-01T09:00:00.000Z",
            lastActivityAt: "2026-04-01T10:00:00.000Z",
          },
        ],
      };
      const before = JSON.stringify(thread);

      const result = applyThreadDetailEvent(
        thread,
        {
          ...baseEventFields,
          sequence: 12,
          occurredAt: "2026-04-01T11:00:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.activity-appended",
          payload: {
            threadId: ThreadId.make("thread-1"),
            activity: {
              id: EventId.make("new-eligible-activity"),
              tone: "tool",
              kind: "tool.completed",
              summary: "Large historical command",
              payload: { output: "x".repeat(100_000) },
              turnId: historicalTurnId,
              sequence: 11,
              createdAt: "2026-04-01T10:30:00.000Z",
            },
          },
        },
        "compact",
      );

      expect(result).toEqual({
        kind: "authoritative-refresh-required",
        reason: "historical-activity-changed",
        turnId: historicalTurnId,
      });
      expect(JSON.stringify(thread)).toBe(before);
    });

    it("requests the same refresh for a same-id ineligible historical update", () => {
      const historicalTurnId = TurnId.make("turn-history");
      const thread: OrchestrationThread = {
        ...baseThread,
        latestTurn: {
          turnId: TurnId.make("turn-current"),
          state: "running",
          requestedAt: "2026-04-01T11:00:00.000Z",
          startedAt: "2026-04-01T11:00:00.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
        historicalActivityGroups: [
          {
            turnId: historicalTurnId,
            revision: 10,
            activityCount: 8,
            payloadBytes: 4_096,
            displayActivityCount: 3,
            firstActivityAt: "2026-04-01T09:00:00.000Z",
            lastActivityAt: "2026-04-01T10:00:00.000Z",
          },
        ],
      };

      const result = applyThreadDetailEvent(
        thread,
        {
          ...baseEventFields,
          sequence: 12,
          occurredAt: "2026-04-01T11:00:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.activity-appended",
          payload: {
            threadId: ThreadId.make("thread-1"),
            activity: {
              // Compact metadata cannot reveal whether this ID already exists.
              id: EventId.make("existing-hidden-activity"),
              tone: "tool",
              kind: "tool.started",
              summary: "Historical command started",
              payload: {},
              turnId: historicalTurnId,
              sequence: 11,
              createdAt: "2026-04-01T09:30:00.000Z",
            },
          },
        },
        "compact",
      );

      expect(result.kind).toBe("authoritative-refresh-required");
      expect(thread.historicalActivityGroups?.[0]).toMatchObject({
        revision: 10,
        activityCount: 8,
        payloadBytes: 4_096,
        displayActivityCount: 3,
      });
    });

    it("upserts globally promoted historical activities without refreshing", () => {
      const historicalTurnId = TurnId.make("turn-history");
      const thread: OrchestrationThread = {
        ...baseThread,
        latestTurn: {
          turnId: TurnId.make("turn-current"),
          state: "running",
          requestedAt: "2026-04-01T11:00:00.000Z",
          startedAt: "2026-04-01T11:00:00.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
        historicalActivityGroups: [
          {
            turnId: historicalTurnId,
            revision: 10,
            activityCount: 8,
            payloadBytes: 4_096,
            displayActivityCount: 3,
            firstActivityAt: "2026-04-01T09:00:00.000Z",
            lastActivityAt: "2026-04-01T10:00:00.000Z",
          },
        ],
      };

      for (const kind of ["turn.plan.updated", "subagent.thread"] as const) {
        const activityId = EventId.make(`promoted-${kind}`);
        const threadWithPromotedActivity: OrchestrationThread = {
          ...thread,
          activities: [
            {
              id: activityId,
              tone: "info",
              kind,
              summary: `Original ${kind}`,
              payload: {},
              turnId: historicalTurnId,
              sequence: 10,
              createdAt: "2026-04-01T09:00:00.000Z",
            },
          ],
        };
        const result = applyThreadDetailEvent(
          threadWithPromotedActivity,
          {
            ...baseEventFields,
            sequence: 12,
            occurredAt: "2026-04-01T11:00:00.000Z",
            aggregateKind: "thread",
            aggregateId: ThreadId.make("thread-1"),
            type: "thread.activity-appended",
            payload: {
              threadId: ThreadId.make("thread-1"),
              activity: {
                id: activityId,
                tone: "info",
                kind,
                summary: `Promoted ${kind}`,
                payload: {},
                turnId: historicalTurnId,
                sequence: 11,
                createdAt: "2026-04-01T09:30:00.000Z",
              },
            },
          },
          "compact",
        );

        expect(result.kind).toBe("updated");
        if (result.kind === "updated") {
          expect(result.thread.activities.map((activity) => activity.kind)).toEqual([kind]);
          expect(result.thread.historicalActivityGroups).toEqual(thread.historicalActivityGroups);
        }
      }
    });

    it("refreshes a newly promoted inactive activity whose id is not already hot", () => {
      const historicalTurnId = TurnId.make("turn-history");
      const result = applyThreadDetailEvent(
        {
          ...baseThread,
          latestTurn: {
            turnId: TurnId.make("turn-current"),
            state: "running",
            requestedAt: "2026-04-01T11:00:00.000Z",
            startedAt: "2026-04-01T11:00:00.000Z",
            completedAt: null,
            assistantMessageId: null,
          },
        },
        {
          ...baseEventFields,
          sequence: 12,
          occurredAt: "2026-04-01T11:00:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.activity-appended",
          payload: {
            threadId: ThreadId.make("thread-1"),
            activity: {
              id: EventId.make("newly-promoted-plan"),
              tone: "info",
              kind: "turn.plan.updated",
              summary: "Newly promoted plan",
              payload: {},
              turnId: historicalTurnId,
              sequence: 11,
              createdAt: "2026-04-01T09:30:00.000Z",
            },
          },
        },
        "compact",
      );

      expect(result.kind).toBe("authoritative-refresh-required");
    });

    it("adds an activity", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 12,
        occurredAt: "2026-04-01T11:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.activity-appended",
        payload: {
          threadId: ThreadId.make("thread-1"),
          activity: {
            id: EventId.make("activity-1"),
            tone: "tool",
            kind: "file-edit",
            summary: "Edited src/index.ts",
            payload: {},
            turnId: TurnId.make("turn-1"),
            createdAt: "2026-04-01T11:00:00.000Z",
          },
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.activities).toHaveLength(1);
        expect(result.thread.activities[0]?.kind).toBe("file-edit");
      }
    });

    it("preserves the complete activity history when live events arrive", () => {
      const existingActivities = Array.from({ length: 129 }, (_, index) => ({
        id: EventId.make(`activity-${index}`),
        tone: "tool" as const,
        kind: "command",
        summary: `Ran command ${index}`,
        payload: {},
        turnId: TurnId.make("turn-1"),
        sequence: index,
        createdAt: "2026-04-01T11:00:00.000Z",
      }));
      const result = applyThreadDetailEvent(
        { ...baseThread, activities: existingActivities },
        {
          ...baseEventFields,
          sequence: 130,
          occurredAt: "2026-04-01T11:01:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.activity-appended",
          payload: {
            threadId: ThreadId.make("thread-1"),
            activity: {
              id: EventId.make("activity-129"),
              tone: "tool",
              kind: "command",
              summary: "Ran command 129",
              payload: {},
              turnId: TurnId.make("turn-1"),
              sequence: 129,
              createdAt: "2026-04-01T11:01:00.000Z",
            },
          },
        },
      );

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.activities).toHaveLength(130);
        expect(result.thread.activities[0]?.id).toBe("activity-0");
      }
    });

    it("repositions a stable activity id only when its ordering key changes", () => {
      const existingActivities = [1, 2, 3].map((sequence) => ({
        id: EventId.make(sequence === 2 ? "activity-stable" : `activity-${sequence}`),
        tone: "tool" as const,
        kind: "command",
        summary: `Activity ${sequence}`,
        payload: {},
        turnId: TurnId.make("turn-1"),
        sequence,
        createdAt: `2026-04-01T11:00:0${sequence}.000Z`,
      }));
      const result = applyThreadDetailEvent(
        { ...baseThread, activities: existingActivities },
        {
          ...baseEventFields,
          sequence: 14,
          occurredAt: "2026-04-01T11:01:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.activity-appended",
          payload: {
            threadId: ThreadId.make("thread-1"),
            activity: {
              ...existingActivities[1]!,
              sequence: 4,
              summary: "Updated stable activity",
            },
          },
        },
      );

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.activities.map((entry) => entry.id)).toEqual([
          "activity-1",
          "activity-3",
          "activity-stable",
        ]);
        expect(result.thread.activities.at(-1)?.summary).toBe("Updated stable activity");
      }
    });

    it("replaces earlier resolvable context-window updates for the same turn", () => {
      const contextWindowActivity = (id: string, sequence: number, usedTokens: unknown) => ({
        id: EventId.make(id),
        tone: "info" as const,
        kind: "context-window.updated",
        summary: "Context window updated",
        payload: { usedTokens },
        turnId: TurnId.make("turn-1"),
        sequence,
        createdAt: "2026-04-01T11:00:00.000Z",
      });
      const otherTurnActivity = contextWindowActivity("activity-other-turn", 2, 500);
      const existingActivities = [
        contextWindowActivity("activity-cw-1", 1, 1_000),
        { ...otherTurnActivity, turnId: TurnId.make("turn-0") },
        // Malformed row (no usedTokens): must survive, and must not be
        // treated as the latest value by consumers.
        contextWindowActivity("activity-cw-malformed", 3, undefined),
        contextWindowActivity("activity-cw-2", 4, 2_000),
      ];

      const result = applyThreadDetailEvent(
        { ...baseThread, activities: existingActivities },
        {
          ...baseEventFields,
          sequence: 20,
          occurredAt: "2026-04-01T11:02:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.activity-appended",
          payload: {
            threadId: ThreadId.make("thread-1"),
            activity: contextWindowActivity("activity-cw-3", 5, 3_000),
          },
        },
      );

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        const ids = result.thread.activities.map((activity) => activity.id);
        // Same-turn resolvable rows collapse to the newest; the other turn's
        // row and the malformed row are untouched.
        expect(ids).toEqual(["activity-other-turn", "activity-cw-malformed", "activity-cw-3"]);
      }
    });

    it("does not collapse context-window history for a malformed update", () => {
      const resolvable = {
        id: EventId.make("activity-cw-resolvable"),
        tone: "info" as const,
        kind: "context-window.updated",
        summary: "Context window updated",
        payload: { usedTokens: 1_000 },
        turnId: TurnId.make("turn-1"),
        sequence: 1,
        createdAt: "2026-04-01T11:00:00.000Z",
      };

      const result = applyThreadDetailEvent(
        { ...baseThread, activities: [resolvable] },
        {
          ...baseEventFields,
          sequence: 21,
          occurredAt: "2026-04-01T11:03:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.activity-appended",
          payload: {
            threadId: ThreadId.make("thread-1"),
            activity: {
              ...resolvable,
              id: EventId.make("activity-cw-broken"),
              payload: { usedTokens: Number.NaN },
              sequence: 2,
            },
          },
        },
      );

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        // The resolvable row must survive so consumers can still derive a
        // usage value by walking backwards past the malformed row.
        const ids = result.thread.activities.map((activity) => activity.id);
        expect(ids).toEqual(["activity-cw-resolvable", "activity-cw-broken"]);
      }
    });
  });

  describe("thread.turn-diff-completed", () => {
    it("adds a checkpoint and updates latestTurn", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 13,
        occurredAt: "2026-04-01T12:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.turn-diff-completed",
        payload: {
          threadId: ThreadId.make("thread-1"),
          turnId: TurnId.make("turn-1"),
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("ref-1"),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.make("msg-3"),
          completedAt: "2026-04-01T12:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.checkpoints).toHaveLength(1);
        expect(result.thread.latestTurn?.turnId).toBe("turn-1");
        expect(result.thread.latestTurn?.state).toBe("completed");
      }
    });
  });

  describe("thread.reverted", () => {
    it("filters entities to retained turns", () => {
      const threadWithData: OrchestrationThread = {
        ...baseThread,
        messages: [
          {
            id: MessageId.make("msg-1"),
            role: "user",
            text: "First",
            turnId: null,
            streaming: false,
            createdAt: "2026-04-01T01:00:00.000Z",
            updatedAt: "2026-04-01T01:00:00.000Z",
          },
          {
            id: MessageId.make("msg-2"),
            role: "assistant",
            text: "Response 1",
            turnId: TurnId.make("turn-1"),
            streaming: false,
            createdAt: "2026-04-01T02:00:00.000Z",
            updatedAt: "2026-04-01T02:00:00.000Z",
          },
          {
            id: MessageId.make("msg-3"),
            role: "assistant",
            text: "Response 2",
            turnId: TurnId.make("turn-2"),
            streaming: false,
            createdAt: "2026-04-01T03:00:00.000Z",
            updatedAt: "2026-04-01T03:00:00.000Z",
          },
        ],
        checkpoints: [
          {
            turnId: TurnId.make("turn-1"),
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("ref-1"),
            status: "ready",
            files: [],
            assistantMessageId: MessageId.make("msg-2"),
            completedAt: "2026-04-01T02:00:00.000Z",
          },
          {
            turnId: TurnId.make("turn-2"),
            checkpointTurnCount: 2,
            checkpointRef: CheckpointRef.make("ref-2"),
            status: "ready",
            files: [],
            assistantMessageId: MessageId.make("msg-3"),
            completedAt: "2026-04-01T03:00:00.000Z",
          },
        ],
      };

      const result = applyThreadDetailEvent(threadWithData, {
        ...baseEventFields,
        sequence: 14,
        occurredAt: "2026-04-01T04:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.reverted",
        payload: {
          threadId: ThreadId.make("thread-1"),
          turnCount: 1,
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        // turn-2 checkpoint is filtered out (turnCount 2 > revert target 1)
        expect(result.thread.checkpoints).toHaveLength(1);
        expect(result.thread.checkpoints[0]?.turnId).toBe("turn-1");
        // msg-3 (turn-2) is filtered, msg-1 (no turn) and msg-2 (turn-1) remain
        expect(result.thread.messages).toHaveLength(2);
        expect(result.thread.latestTurn?.turnId).toBe("turn-1");
        expect(result.thread.updatedAt).toBe("2026-04-01T04:00:00.000Z");
      }
    });
  });

  describe("thread.history-pruned", () => {
    it("removes the target user message and later history without requiring checkpoints", () => {
      const threadWithData: OrchestrationThread = {
        ...baseThread,
        latestTurn: {
          turnId: TurnId.make("turn-2"),
          state: "completed",
          requestedAt: "2026-04-01T03:00:00.000Z",
          startedAt: "2026-04-01T03:00:01.000Z",
          completedAt: "2026-04-01T03:00:10.000Z",
          assistantMessageId: MessageId.make("msg-4"),
        },
        messages: [
          {
            id: MessageId.make("msg-1"),
            role: "user",
            text: "Keep",
            turnId: null,
            streaming: false,
            createdAt: "2026-04-01T01:00:00.000Z",
            updatedAt: "2026-04-01T01:00:00.000Z",
          },
          {
            id: MessageId.make("msg-2"),
            role: "assistant",
            text: "Kept response",
            turnId: TurnId.make("turn-1"),
            streaming: false,
            createdAt: "2026-04-01T02:00:00.000Z",
            updatedAt: "2026-04-01T02:00:00.000Z",
          },
          {
            id: MessageId.make("msg-3"),
            role: "user",
            text: "Remove",
            turnId: null,
            streaming: false,
            createdAt: "2026-04-01T03:00:00.000Z",
            updatedAt: "2026-04-01T03:00:00.000Z",
          },
          {
            id: MessageId.make("msg-4"),
            role: "assistant",
            text: "Removed response",
            turnId: TurnId.make("turn-2"),
            streaming: false,
            createdAt: "2026-04-01T03:00:10.000Z",
            updatedAt: "2026-04-01T03:00:10.000Z",
          },
        ],
        activities: [
          {
            id: EventId.make("activity-1"),
            tone: "tool",
            kind: "tool.completed",
            summary: "kept",
            payload: {},
            turnId: TurnId.make("turn-1"),
            createdAt: "2026-04-01T02:00:00.000Z",
          },
          {
            id: EventId.make("activity-2"),
            tone: "tool",
            kind: "tool.completed",
            summary: "removed",
            payload: {},
            turnId: TurnId.make("turn-2"),
            createdAt: "2026-04-01T03:00:10.000Z",
          },
        ],
        checkpoints: [],
      };

      const result = applyThreadDetailEvent(threadWithData, {
        ...baseEventFields,
        sequence: 15,
        occurredAt: "2026-04-01T04:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.history-pruned",
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("msg-3"),
          pruneFromCreatedAt: "2026-04-01T03:00:00.000Z",
          prunedTurnIds: [TurnId.make("turn-2")],
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.messages.map((message) => message.id)).toEqual(["msg-1", "msg-2"]);
        expect(result.thread.activities.map((activity) => activity.id)).toEqual(["activity-1"]);
        expect(result.thread.latestTurn).toBeNull();
      }
    });

    it("applies explicit prune metadata when the target message is already missing", () => {
      const keptTurnId = TurnId.make("turn-kept");
      const prunedTurnId = TurnId.make("turn-pruned");
      const keptMessage = {
        id: MessageId.make("message-kept"),
        role: "assistant" as const,
        text: "Already projected",
        turnId: keptTurnId,
        streaming: false,
        createdAt: "2026-04-01T01:00:00.000Z",
        updatedAt: "2026-04-01T01:00:00.000Z",
      };
      const thread: OrchestrationThread = {
        ...baseThread,
        messages: [keptMessage],
        latestTurn: {
          turnId: prunedTurnId,
          state: "completed",
          requestedAt: "2026-04-01T02:00:00.000Z",
          startedAt: "2026-04-01T02:00:00.000Z",
          completedAt: "2026-04-01T02:01:00.000Z",
          assistantMessageId: null,
        },
        activities: [
          {
            id: EventId.make("activity-kept"),
            tone: "tool",
            kind: "tool.completed",
            summary: "Kept",
            payload: {},
            turnId: keptTurnId,
            revision: 2,
            createdAt: "2026-04-01T01:00:00.000Z",
          },
        ],
        historicalActivityGroups: [
          {
            turnId: keptTurnId,
            revision: 2,
            activityCount: 1,
            payloadBytes: 2,
            displayActivityCount: 1,
            firstActivityAt: "2026-04-01T01:00:00.000Z",
            lastActivityAt: "2026-04-01T01:00:00.000Z",
          },
          {
            turnId: prunedTurnId,
            revision: 3,
            activityCount: 1,
            payloadBytes: 2,
            displayActivityCount: 1,
            firstActivityAt: "2026-04-01T02:00:00.000Z",
            lastActivityAt: "2026-04-01T02:00:00.000Z",
          },
        ],
      };

      const result = applyThreadDetailEvent(thread, {
        ...baseEventFields,
        sequence: 15,
        occurredAt: "2026-04-01T04:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.history-pruned",
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("already-missing-target"),
          pruneFromCreatedAt: "2026-04-01T02:00:00.000Z",
          prunedTurnIds: [prunedTurnId],
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.messages).toEqual([keptMessage]);
        expect(result.thread.latestTurn).toBeNull();
        expect(result.thread.activities).toHaveLength(1);
        expect(result.thread.activities[0]?.revision).toBe(15);
        expect(result.thread.historicalActivityGroups).toHaveLength(1);
        expect(result.thread.historicalActivityGroups?.[0]?.revision).toBe(15);
        expect(result.thread.updatedAt).toBe("2026-04-01T04:00:00.000Z");
      }
    });
  });

  describe("no-op events", () => {
    it("returns unchanged for approval-response-requested", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 15,
        occurredAt: "2026-04-01T13:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.approval-response-requested",
        payload: {
          threadId: ThreadId.make("thread-1"),
          requestId: "req-1",
          decision: "approve",
          createdAt: "2026-04-01T13:00:00.000Z",
        },
      } as any);
      expect(result.kind).toBe("unchanged");
    });
  });
});
