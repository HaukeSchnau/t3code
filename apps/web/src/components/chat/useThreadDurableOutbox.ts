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
import { newCommandId } from "../../lib/utils";
import { useEnvironment } from "../../state/environments";
import type { ChatMessage, Thread } from "../../types";
import { selectThreadDurableOutboxEntries } from "./durableOutboxPresentation";

export interface QueuedMessage {
  readonly messageId: MessageId;
  readonly threadId: ScopedThreadRef["threadId"];
  readonly text: string;
  readonly attachments: DurableClientCommand["message"]["attachments"];
  readonly modelSelection?: DurableClientCommand["modelSelection"];
  readonly runtimeMode?: DurableClientCommand["runtimeMode"];
  readonly interactionMode?: DurableClientCommand["interactionMode"];
  readonly createdAt?: DurableClientCommand["createdAt"];
  readonly updatedAt?: string;
}

type ThreadWithLegacyQueue = Pick<Thread, "environmentId" | "id"> & {
  readonly queuedMessages?: ReadonlyArray<QueuedMessage>;
};

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
      if (clearErrorBeforeAction) onError(null);
      try {
        await runQueuedMessageAction({
          action,
          threadRef,
          messageId: message.messageId,
          dispatch: async () => {
            throw new Error("Remote queued message controls are unavailable on V2 threads.");
          },
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
  thread: ThreadWithLegacyQueue,
): ReadonlyArray<ChatMessage> {
  const entryByMessageId = new Map(
    entries.map((entry) => [entry.plan.command.message.messageId, entry] as const),
  );
  const alreadyVisibleMessageIds = new Set((thread.queuedMessages ?? []).map((message) => message.messageId));
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
      runId: null,
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
  const legacyQueue = thread as ThreadWithLegacyQueue | undefined;
  const queuedMessageIds = useMemo(
    () => new Set((legacyQueue?.queuedMessages ?? []).map((message) => message.messageId)),
    [legacyQueue?.queuedMessages],
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
            queuedMessages: legacyQueue?.queuedMessages ?? [],
          })
        : [],
    [acceptedEntries, environmentId, legacyQueue?.queuedMessages, pendingEntries, threadId],
  );

  useEffect(() => {
    if (environment?.connection.phase === "connected") durableCommandOutbox().wake();
  }, [environment?.connection.phase]);

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
