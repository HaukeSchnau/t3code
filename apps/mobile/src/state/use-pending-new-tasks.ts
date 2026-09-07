import { useMemo } from "react";
import { deriveThreadTitleSeed } from "@t3tools/client-runtime/operations";
import type { DurableCommandState } from "@t3tools/client-runtime/operations/command-outbox";

import {
  flattenQueuedThreadMessages,
  type QueuedThreadCreation,
  type QueuedThreadMessage,
} from "./thread-outbox-model";
import { useThreadOutboxDeliveryStates, useThreadOutboxMessages } from "./use-thread-outbox";

/** A queued new-task creation, shaped for thread-list presentation. */
export interface PendingNewTask {
  /** Compatibility projection for list surfaces still consuming the legacy flat shape. */
  readonly kind: "pending" | "draft";
  readonly key: string;
  readonly environmentId: QueuedThreadMessage["environmentId"];
  readonly projectId: QueuedThreadCreation["projectId"];
  readonly projectTitle?: string;
  readonly projectCwd?: string;
  readonly branch: string | null;
  readonly createdAt: string;
  readonly draftKey?: string;
  readonly deliveryState?: DurableCommandState;
  readonly message: QueuedThreadMessage;
  readonly creation: QueuedThreadCreation;
  readonly title: string;
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
        kind: "pending",
        key: `pending-task:${message.messageId}`,
        environmentId: message.environmentId,
        projectId: message.creation.projectId,
        projectTitle: message.creation.projectTitle,
        projectCwd: message.creation.projectCwd,
        branch: message.creation.branch,
        createdAt: message.createdAt,
        deliveryState: deliveryStates[message.commandId],
        message,
        creation: message.creation,
        title: deriveThreadTitleSeed({ text: message.text, attachments: message.attachments }),
      });
    }
    tasks.sort((left, right) => right.message.createdAt.localeCompare(left.message.createdAt));
    return tasks;
  }, [deliveryStates, queuedMessagesByThreadKey]);
}
