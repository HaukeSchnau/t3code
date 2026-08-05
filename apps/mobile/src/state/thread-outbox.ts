import type { EnvironmentId } from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";

import { randomHex } from "../lib/uuid";

import { appAtomRegistry } from "./atom-registry";
import { createThreadOutboxManager } from "./thread-outbox-manager";
import type { QueuedThreadMessage } from "./thread-outbox-model";
import { expoThreadOutboxStorage } from "./thread-outbox-storage";

export * from "./thread-outbox-model";

export const threadOutboxManager = createThreadOutboxManager({
  registry: appAtomRegistry,
  storage: expoThreadOutboxStorage,
});

export function ensureThreadOutboxLoaded(): void {
  void threadOutboxManager.load();
}

export function enqueueThreadOutboxMessage(message: QueuedThreadMessage): Promise<void> {
  return threadOutboxManager.enqueue(freezeDeliveryIdentity(message));
}

function freezeDeliveryIdentity(message: QueuedThreadMessage): QueuedThreadMessage {
  if (message.creation?.workspaceMode !== "worktree" || message.deliveryWorktreeBranchName) {
    return message;
  }
  return {
    ...message,
    deliveryWorktreeBranchName: buildTemporaryWorktreeBranchName(randomHex),
  };
}

/** Replace pending intent under mandatory fresh command and message identities. */
export function updateThreadOutboxMessage(
  previous: QueuedThreadMessage,
  replacement: QueuedThreadMessage,
): Promise<boolean> {
  return threadOutboxManager.update(previous, freezeDeliveryIdentity(replacement));
}

/** Waits for pending writes to settle; false if the message was rolled back. */
export function confirmThreadOutboxMessageQueued(message: QueuedThreadMessage): Promise<boolean> {
  return threadOutboxManager.confirmQueued(message);
}

export function removeThreadOutboxMessage(message: QueuedThreadMessage): Promise<void> {
  return threadOutboxManager.remove(message);
}

export function clearThreadOutboxEnvironment(environmentId: EnvironmentId): Promise<void> {
  return threadOutboxManager.clearEnvironment(environmentId);
}
