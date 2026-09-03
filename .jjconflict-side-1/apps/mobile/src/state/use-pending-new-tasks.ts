import { useMemo } from "react";

import { deriveThreadTitleFromPrompt } from "../lib/projectThreadStartTurn";
import {
  flattenQueuedThreadMessages,
  type QueuedThreadCreation,
  type QueuedThreadMessage,
} from "./thread-outbox-model";
import { useThreadOutboxMessages } from "./use-thread-outbox";
import { useThreadOutboxDeliveryStates } from "./use-thread-outbox";
import type { DurableCommandState } from "@t3tools/client-runtime/operations/command-outbox";

/** A queued new-task creation, shaped for thread-list presentation. */
export interface PendingNewTask {
  readonly message: QueuedThreadMessage;
  readonly creation: QueuedThreadCreation;
  readonly title: string;
  readonly deliveryState: DurableCommandState | undefined;
}

export function usePendingNewTasks(): ReadonlyArray<PendingNewTask> {
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  const deliveryStates = useThreadOutboxDeliveryStates();
  return useMemo(() => {
    const tasks: PendingNewTask[] = [];
    for (const message of flattenQueuedThreadMessages(queuedMessagesByThreadKey)) {
      if (!message.creation) {
        continue;
      }
      tasks.push({
        message,
        creation: message.creation,
        title: deriveThreadTitleFromPrompt(message.text),
        deliveryState: deliveryStates[message.commandId],
      });
    }
    tasks.sort((left, right) => right.message.createdAt.localeCompare(left.message.createdAt));
    return tasks;
  }, [deliveryStates, queuedMessagesByThreadKey]);
}
