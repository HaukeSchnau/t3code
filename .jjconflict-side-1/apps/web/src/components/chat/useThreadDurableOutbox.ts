import type {
  DurableClientCommand,
  DurableCommandOutboxEntry,
} from "@t3tools/client-runtime/operations/command-outbox";
import type { CommandId, MessageId, ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo } from "react";

import {
  durableCommandOutbox,
  selectDurableOutboxMessages,
  useAcceptedCommandProjectionEntries,
  useDurableCommandOutboxEntries,
} from "../../durableCommandOutbox";
import { readEnvironmentApi } from "../../environmentApi";
import { newCommandId } from "../../lib/utils";
import { useEnvironment } from "../../state/environments";
import type { ChatMessage, QueuedMessage, Thread } from "../../types";
import { collectAuthoritativeProjectedMessageIds } from "../ChatView.logic";
import { selectThreadDurableOutboxEntries } from "./durableOutboxPresentation";

type QueuedMessageAction = "dispatch" | "delete";

const QUEUED_MESSAGE_FAILURE_COPY: Record<QueuedMessageAction, string> = {
  dispatch: "Failed to send queued message.",
  delete: "Failed to remove queued message.",
};

const currentIsoTime = () => new Date().toISOString();

export async function runQueuedMessageAction(input: {
  readonly action: QueuedMessageAction;
  readonly threadRef: ScopedThreadRef;
  readonly messageId: MessageId;
  readonly dispatch: (command: {
    readonly type: "thread.queued-message.dispatch" | "thread.queued-message.delete";
    readonly commandId: CommandId;
    readonly threadId: ScopedThreadRef["threadId"];
    readonly messageId: MessageId;
    readonly createdAt: string;
  }) => Promise<unknown>;
  readonly makeCommandId: () => CommandId;
  readonly now: () => string;
}): Promise<void> {
  await input.dispatch({
    type:
      input.action === "dispatch"
        ? "thread.queued-message.dispatch"
        : "thread.queued-message.delete",
    commandId: input.makeCommandId(),
    threadId: input.threadRef.threadId,
    messageId: input.messageId,
    createdAt: input.now(),
  });
}

export function useThreadQueuedMessageControls(input: {
  readonly threadRef: ScopedThreadRef;
  readonly clearErrorBeforeAction?: boolean;
  readonly onError: (message: string | null) => void;
}): {
  readonly dispatchQueuedMessage: (message: QueuedMessage) => Promise<void>;
  readonly deleteQueuedMessage: (message: QueuedMessage) => Promise<void>;
} {
  const { clearErrorBeforeAction = false, onError, threadRef } = input;
  const runAction = useCallback(
    async (action: QueuedMessageAction, message: QueuedMessage) => {
      const api = readEnvironmentApi(threadRef.environmentId);
      if (!api) return;
      if (clearErrorBeforeAction) onError(null);
      try {
        await runQueuedMessageAction({
          action,
          threadRef,
          messageId: message.messageId,
          dispatch: (command) => api.orchestration.dispatchCommand(command),
          makeCommandId: newCommandId,
          now: currentIsoTime,
        });
      } catch (error) {
        onError(error instanceof Error ? error.message : QUEUED_MESSAGE_FAILURE_COPY[action]);
      }
    },
    [clearErrorBeforeAction, onError, threadRef],
  );

  return {
    dispatchQueuedMessage: useCallback((message) => runAction("dispatch", message), [runAction]),
    deleteQueuedMessage: useCallback((message) => runAction("delete", message), [runAction]),
  };
}

export function projectThreadDurableOptimisticMessages(
  entries: ReadonlyArray<DurableCommandOutboxEntry>,
  thread: Pick<Thread, "environmentId" | "id" | "queuedMessages">,
): ReadonlyArray<ChatMessage> {
  const entryByMessageId = new Map(
    entries.map((entry) => [entry.plan.command.message.messageId, entry] as const),
  );
  const alreadyVisibleMessageIds = new Set(
    (thread.queuedMessages ?? []).map((message) => message.messageId),
  );
  return selectDurableOutboxMessages(
    entries.filter((entry) => entry.plan.command.type === "thread.turn.start"),
    thread.environmentId,
    thread.id,
    alreadyVisibleMessageIds,
  ).map((message) => {
    const createdAt =
      entryByMessageId.get(message.messageId)?.plan.command.createdAt ?? new Date(0).toISOString();
    return {
      id: message.messageId,
      role: "user",
      text: message.text,
      turnId: null,
      createdAt,
      updatedAt: createdAt,
      streaming: false,
    };
  });
}

export function useThreadDurableOutbox(thread: Thread | undefined): {
  readonly entries: ReadonlyArray<DurableCommandOutboxEntry>;
  readonly optimisticMessages: ReadonlyArray<ChatMessage>;
  readonly enqueue: (
    environmentId: Thread["environmentId"],
    command: DurableClientCommand,
  ) => Promise<unknown>;
  readonly cancel: (commandId: CommandId) => Promise<void>;
  readonly replace: (
    commandId: CommandId,
    replacement: DurableClientCommand,
    state: "Pending" | "Rejected",
  ) => Promise<void>;
  readonly discard: (commandId: CommandId) => Promise<void>;
} {
  const pendingEntries = useDurableCommandOutboxEntries();
  const acceptedEntries = useAcceptedCommandProjectionEntries();
  const environmentId = thread?.environmentId ?? null;
  const threadId = thread?.id ?? null;
  const environment = useEnvironment(environmentId);
  const queuedMessageIds = useMemo(
    () => new Set((thread?.queuedMessages ?? []).map((message) => message.messageId)),
    [thread?.queuedMessages],
  );
  const entries = useMemo(
    () =>
      environmentId !== null && threadId !== null
        ? selectThreadDurableOutboxEntries(
            pendingEntries,
            environmentId,
            threadId,
            queuedMessageIds,
          )
        : [],
    [environmentId, pendingEntries, queuedMessageIds, threadId],
  );
  const optimisticMessages = useMemo(
    () =>
      environmentId !== null && threadId !== null
        ? projectThreadDurableOptimisticMessages([...pendingEntries, ...acceptedEntries], {
            environmentId,
            id: threadId,
            queuedMessages: thread?.queuedMessages ?? [],
          })
        : [],
    [acceptedEntries, environmentId, pendingEntries, thread?.queuedMessages, threadId],
  );

  useEffect(() => {
    if (environment?.connection.phase === "connected") durableCommandOutbox().wake();
  }, [environment?.connection.phase]);

  useEffect(() => {
    if (!thread || acceptedEntries.length === 0) return;
    const projectedMessageIds = collectAuthoritativeProjectedMessageIds(thread);
    if (projectedMessageIds.size > 0) {
      void durableCommandOutbox().confirmProjected(projectedMessageIds);
    }
  }, [acceptedEntries.length, thread]);

  return {
    entries,
    optimisticMessages,
    enqueue: useCallback(
      (environmentId, command) => durableCommandOutbox().enqueue(environmentId, command),
      [],
    ),
    cancel: useCallback((commandId) => durableCommandOutbox().cancelPending(commandId), []),
    replace: useCallback(async (commandId, replacement, state) => {
      if (state === "Pending") {
        await durableCommandOutbox().replacePending(commandId, replacement);
      } else {
        await durableCommandOutbox().replaceRejected(commandId, replacement);
      }
    }, []),
    discard: useCallback((commandId) => durableCommandOutbox().discardRejected(commandId), []),
  };
}
