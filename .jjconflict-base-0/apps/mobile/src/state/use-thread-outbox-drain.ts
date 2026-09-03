import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { type MessageId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useRef, useState } from "react";

import { prepareTurnAttachments, type PreparedTurnAttachments } from "../lib/attachmentUpload";
import { scopedProjectKey, scopedThreadKey } from "../lib/scopedEntities";
import { appAtomRegistry } from "./atom-registry";
import { useProjects, useThreadShells } from "./entities";
import {
  confirmThreadOutboxMessageQueued,
  ensureThreadOutboxLoaded,
  threadOutboxRevision,
  threadOutboxManager,
  updateThreadOutboxMessage,
} from "./thread-outbox";
import { removeThreadOutboxMessage } from "./thread-outbox-removal";
import {
  isQueuedThreadCreationSendable,
  resolveThreadOutboxDeliveryAction,
  resolveThreadOutboxFailureAction,
  threadOutboxRetryDelayMs,
  type QueuedThreadCreation,
  type QueuedThreadMessage,
  type ThreadOutboxCommandStage,
} from "./thread-outbox-model";
import { threadEnvironment } from "./threads";
import { useAtomCommand } from "./use-atom-command";
import {
  editingQueuedMessageIdsAtom,
  effectiveEditingQueuedMessageIdsAtom,
  useThreadOutboxMessages,
  useThreadOutboxShellStatuses,
} from "./use-thread-outbox";
import {
  appendComposerDraftAttachments,
  composerDraftsReadyAtom,
  ensureComposerDraftsLoaded,
  flushComposerDrafts,
  getComposerDraftSnapshot,
  mergeComposerDraftContent,
  removeDeliveredCloudQueuedMessage,
  undoComposerDraftMerge,
  updateComposerDraftSettings,
  waitForComposerDraftsLoaded,
  type ComposerDraft,
} from "./use-composer-drafts";
import {
  setPendingConnectionError,
  useRemoteConnectionStatus,
} from "./use-remote-environment-registry";

export const dispatchingQueuedMessageIdAtom = Atom.make<MessageId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:thread-outbox:dispatching-message-id"),
);

function beginDispatchingQueuedMessage(queuedMessageId: MessageId): void {
  appAtomRegistry.set(dispatchingQueuedMessageIdAtom, queuedMessageId);
}

function finishDispatchingQueuedMessage(queuedMessageId: MessageId): void {
  const current = appAtomRegistry.get(dispatchingQueuedMessageIdAtom);
  appAtomRegistry.set(dispatchingQueuedMessageIdAtom, current === queuedMessageId ? null : current);
}

function findThread(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  message: QueuedThreadMessage,
): EnvironmentThreadShell | undefined {
  return threads.find(
    (candidate) =>
      candidate.environmentId === message.environmentId && candidate.id === message.threadId,
  );
}

function findCreationProject(
  projects: ReadonlyArray<EnvironmentProject>,
  message: QueuedThreadMessage,
): EnvironmentProject | undefined {
  return projects.find(
    (candidate) =>
      candidate.environmentId === message.environmentId &&
      candidate.id === message.creation?.projectId,
  );
}

export async function prepareQueuedMessageAttachments(
  queuedMessage: QueuedThreadMessage,
  supportsImageUploads = false,
): Promise<
  | {
      readonly status: "ready";
      readonly prepared: PreparedTurnAttachments;
      readonly persistedMessage: QueuedThreadMessage;
      readonly deliveryRevision: number;
    }
  | { readonly status: "abandoned" }
> {
  if (!(await confirmThreadOutboxMessageQueued(queuedMessage))) {
    return { status: "abandoned" };
  }
  const revision = threadOutboxRevision(queuedMessage.messageId);
  if (!isQueuedMessagePayloadCurrent(queuedMessage, revision)) {
    return { status: "abandoned" };
  }
  let persistedMessage = queuedMessage;
  let deliveryRevision = revision;
  const prepared = await prepareTurnAttachments({
    environmentId: queuedMessage.environmentId,
    attachments: queuedMessage.attachments,
    supportsImageUploads,
    persistUploadedReferences: async (attachments) => {
      if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]) {
        return "abandon";
      }
      const updated = { ...queuedMessage, attachments };
      if (!(await updateThreadOutboxMessage(updated, revision))) {
        return "abandon";
      }
      persistedMessage = updated;
      deliveryRevision = revision + 1;
      return "persisted";
    },
  });
  if (
    prepared.status === "abandoned" ||
    !isQueuedMessagePayloadCurrent(persistedMessage, deliveryRevision)
  ) {
    return { status: "abandoned" };
  }
  return { status: "ready", prepared, persistedMessage, deliveryRevision };
}

function isQueuedMessagePayloadCurrent(
  message: QueuedThreadMessage,
  expectedRevision: number,
): boolean {
  return (
    threadOutboxRevision(message.messageId) === expectedRevision &&
    Object.values(appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom))
      .flat()
      .some((candidate) => candidate === message)
  );
}

export async function completeQueuedMessageDelivery(
  queuedMessage: QueuedThreadMessage,
  deliveryRevision: number,
): Promise<"removed" | "edited" | "failed"> {
  try {
    await removeDeliveredCloudQueuedMessage(queuedMessage).catch((error) => {
      console.warn("[thread-outbox] could not update sign-out snapshot after delivery", error);
    });
    if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]) {
      return "edited";
    }
    const removed = await removeThreadOutboxMessage(
      queuedMessage,
      deliveryRevision,
      () => !appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId],
    );
    return removed ? "removed" : "edited";
  } catch {
    return "failed";
  }
}

export async function removeAcknowledgedExistingThreadMessage(
  queuedMessage: QueuedThreadMessage,
  acknowledgedMessageIds: Set<MessageId>,
): Promise<boolean> {
  try {
    await removeDeliveredCloudQueuedMessage(queuedMessage).catch((error) => {
      console.warn("[thread-outbox] could not update sign-out snapshot after delivery", error);
    });
    const removed = await removeThreadOutboxMessage(queuedMessage);
    if (removed) acknowledgedMessageIds.delete(queuedMessage.messageId);
    return removed;
  } catch {
    return false;
  }
}

export async function recoverEditedCreationAfterDelivery(
  queuedMessage: QueuedThreadMessage,
): Promise<boolean> {
  const kept = Object.values(appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom))
    .flat()
    .find((candidate) => candidate.messageId === queuedMessage.messageId);
  if (!kept || appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]) {
    return true;
  }
  const revision = threadOutboxRevision(kept.messageId);
  const draftKey = scopedThreadKey(kept.environmentId, kept.threadId);
  try {
    await mergeComposerDraftContent(draftKey, { text: kept.text, attachments: [] });
    if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[kept.messageId]) return true;
    if (threadOutboxRevision(kept.messageId) !== revision) return false;
    const existingAttachmentIds = new Set(
      getComposerDraftSnapshot(draftKey).attachments.map((attachment) => attachment.id),
    );
    appendComposerDraftAttachments(
      draftKey,
      kept.attachments.filter((attachment) => !existingAttachmentIds.has(attachment.id)),
      { allowOverflow: true },
    );
    await flushComposerDrafts();
    if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[kept.messageId]) return true;
    if (threadOutboxRevision(kept.messageId) !== revision) return false;
    return await removeThreadOutboxMessage(
      kept,
      revision,
      () => !appAtomRegistry.get(editingQueuedMessageIdsAtom)[kept.messageId],
    );
  } catch {
    return false;
  }
}

export async function restoreRejectedQueuedMessage(
  queuedMessage: QueuedThreadMessage,
  message: string,
): Promise<"restored" | "deferred" | "blocked" | "retry"> {
  if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]) {
    return "deferred";
  }
  const draftKey = queuedMessage.creation
    ? `new-task:${scopedProjectKey(queuedMessage.environmentId, queuedMessage.creation.projectId)}`
    : scopedThreadKey(queuedMessage.environmentId, queuedMessage.threadId);
  let rollback: { readonly snapshot: ComposerDraft; readonly merged: ComposerDraft } | null = null;
  try {
    if (!(await confirmThreadOutboxMessageQueued(queuedMessage))) return "deferred";
    const revision = threadOutboxRevision(queuedMessage.messageId);
    await waitForComposerDraftsLoaded();
    const snapshot = getComposerDraftSnapshot(draftKey);
    let merged: ComposerDraft;
    try {
      await mergeComposerDraftContent(draftKey, {
        text: queuedMessage.text,
        attachments: queuedMessage.attachments,
      });
    } finally {
      merged = getComposerDraftSnapshot(draftKey);
      rollback = { snapshot, merged };
    }
    updateComposerDraftSettings(draftKey, {
      ...(queuedMessage.modelSelection ? { modelSelection: queuedMessage.modelSelection } : {}),
      ...(queuedMessage.runtimeMode ? { runtimeMode: queuedMessage.runtimeMode } : {}),
      ...(queuedMessage.interactionMode ? { interactionMode: queuedMessage.interactionMode } : {}),
      ...(queuedMessage.creation
        ? {
            workspaceSelection: {
              mode: queuedMessage.creation.workspaceMode,
              branch: queuedMessage.creation.branch,
              worktreePath: queuedMessage.creation.worktreePath,
            },
          }
        : {}),
    });
    merged = getComposerDraftSnapshot(draftKey);
    rollback = { snapshot, merged };
    await flushComposerDrafts();
    if (
      appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId] ||
      !(await removeThreadOutboxMessage(queuedMessage, revision))
    ) {
      await undoComposerDraftMerge(draftKey, snapshot, merged);
      return "deferred";
    }
    rollback = null;
    setPendingConnectionError(message);
    return "restored";
  } catch {
    if (rollback !== null) {
      await undoComposerDraftMerge(draftKey, rollback.snapshot, rollback.merged).catch(
        () => undefined,
      );
    }
    return "retry";
  }
}

export function useThreadOutboxDrain(): void {
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const dispatchingQueuedMessageId = useAtomValue(dispatchingQueuedMessageIdAtom);
  const deliveryStates = useAtomValue(threadOutboxManager.deliveryStatesAtom);
  const editingQueuedMessageIds = useAtomValue(effectiveEditingQueuedMessageIdsAtom);
  const composerDraftsReady = useAtomValue(composerDraftsReadyAtom);
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  const shellStatuses = useThreadOutboxShellStatuses();
  const threads = useThreadShells();
  const projects = useProjects();
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const [retryTick, setRetryTick] = useState(0);
  const retryAttemptRef = useRef(new Map<MessageId, number>());
  const retryNotBeforeRef = useRef(new Map<MessageId, number>());
  const retryTimersRef = useRef(new Map<MessageId, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    ensureComposerDraftsLoaded();
    ensureThreadOutboxLoaded();
    return () => {
      for (const timer of retryTimersRef.current.values()) {
        clearTimeout(timer);
      }
      retryTimersRef.current.clear();
    };
  }, []);

  const makeDeliveryHelpers = useCallback((queuedMessage: QueuedThreadMessage) => {
    const reportFailure = (
      commandResult: AtomCommandResult<unknown, unknown>,
      stage: ThreadOutboxCommandStage,
    ): boolean => {
      if (!AsyncResult.isFailure(commandResult)) {
        return false;
      }
      const action = resolveThreadOutboxFailureAction({
        stage,
        error: Cause.squash(commandResult.cause),
        interrupted: Cause.hasInterruptsOnly(commandResult.cause),
      });
      const retry = action === "retry";
      console.warn("[thread-outbox] queued message delivery failed", {
        environmentId: queuedMessage.environmentId,
        threadId: queuedMessage.threadId,
        messageId: queuedMessage.messageId,
        stage,
        cause: commandResult.cause,
        retry,
      });
      return retry;
    };
    const completeDelivery = async (
      deliveryResult: AtomCommandResult<unknown, unknown>,
    ): Promise<boolean> => {
      if (AsyncResult.isFailure(deliveryResult)) {
        const error = Cause.squash(deliveryResult.cause);
        const retry = reportFailure(deliveryResult, "start-turn");
        await threadOutboxManager.fail(
          queuedMessage,
          error,
          new Date().toISOString(),
          retry ? undefined : "permanent",
        );
        return false;
      }

      try {
        // The RPC result is the durable server receipt boundary. Only now may
        // the local intent be removed; a lost response remains retryable with
        // the exact same frozen command identity.
        await threadOutboxManager.complete(queuedMessage);
        return true;
      } catch (error) {
        console.warn("[thread-outbox] failed to remove delivered queued message", {
          environmentId: queuedMessage.environmentId,
          threadId: queuedMessage.threadId,
          messageId: queuedMessage.messageId,
          error,
        });
        return false;
      }
    };
    return { reportFailure, completeDelivery };
  }, []);

  const sendQueuedMessage = useCallback(
    async (queuedMessage: QueuedThreadMessage, _thread: EnvironmentThreadShell) => {
      const { completeDelivery } = makeDeliveryHelpers(queuedMessage);
      const attachmentPreparation = await prepareQueuedMessageAttachments(queuedMessage);
      if (attachmentPreparation.status === "abandoned") return true;
      const begun = await threadOutboxManager.begin(
        attachmentPreparation.persistedMessage,
        new Date().toISOString(),
      );
      const command = begun.plan.command;
      const { type: _, ...input } = command;
      const deliveryResult = await startTurn({
        environmentId: queuedMessage.environmentId,
        input,
      });
      const completed = await completeDelivery(deliveryResult);
      if (completed) await attachmentPreparation.prepared.releaseUploads();
      return completed;
    },
    [makeDeliveryHelpers, startTurn],
  );

  const sendQueuedCreation = useCallback(
    async (
      queuedMessage: QueuedThreadMessage,
      _creation: QueuedThreadCreation,
      _projectCwd: string,
    ) => {
      const modelSelection = queuedMessage.modelSelection;
      if (modelSelection === undefined) {
        return false;
      }
      const { completeDelivery } = makeDeliveryHelpers(queuedMessage);
      const attachmentPreparation = await prepareQueuedMessageAttachments(queuedMessage);
      if (attachmentPreparation.status === "abandoned") return true;
      const begun = await threadOutboxManager.begin(
        attachmentPreparation.persistedMessage,
        new Date().toISOString(),
      );
      const command = begun.plan.command;
      const { type: _, ...input } = command;
      const deliveryResult = await startTurn({
        environmentId: queuedMessage.environmentId,
        input,
      });
      const completed = await completeDelivery(deliveryResult);
      if (completed) await attachmentPreparation.prepared.releaseUploads();
      return completed;
    },
    [makeDeliveryHelpers, startTurn],
  );

  useEffect(() => {
    if (!composerDraftsReady || dispatchingQueuedMessageId !== null) {
      return;
    }

    for (const [threadKey, queuedMessages] of Object.entries(queuedMessagesByThreadKey)) {
      const nextQueuedMessage = queuedMessages[0];
      if (!nextQueuedMessage) {
        continue;
      }
      if (editingQueuedMessageIds[nextQueuedMessage.messageId]) {
        continue;
      }
      const deliveryState = deliveryStates[nextQueuedMessage.commandId];
      if (deliveryState?._tag === "Rejected" || deliveryState?._tag === "Delivering") {
        continue;
      }
      if (deliveryState?._tag === "Retrying") {
        const retryAt = Date.parse(deliveryState.retryNotBefore);
        if (retryAt > Date.now()) {
          retryNotBeforeRef.current.set(nextQueuedMessage.messageId, retryAt);
          if (!retryTimersRef.current.has(nextQueuedMessage.messageId)) {
            const retryTimer = setTimeout(() => {
              retryTimersRef.current.delete(nextQueuedMessage.messageId);
              setRetryTick((current) => current + 1);
            }, retryAt - Date.now());
            retryTimersRef.current.set(nextQueuedMessage.messageId, retryTimer);
          }
          continue;
        }
      }
      if ((retryNotBeforeRef.current.get(nextQueuedMessage.messageId) ?? 0) > Date.now()) {
        continue;
      }

      const thread = findThread(threads, nextQueuedMessage);
      if (thread && scopedThreadKey(thread.environmentId, thread.id) !== threadKey) {
        continue;
      }

      const creation = nextQueuedMessage.creation;
      const environment = connectedEnvironments.find(
        (candidate) => candidate.environmentId === nextQueuedMessage.environmentId,
      );
      const shellStatus = shellStatuses.get(nextQueuedMessage.environmentId) ?? "empty";
      const projectedDeliveryAction = resolveThreadOutboxDeliveryAction({
        isCreation: creation !== undefined,
        threadExists: thread !== undefined,
        shellStatus,
        environmentConnected: environment?.connectionState === "connected",
        threadBusy: thread?.session?.status === "running" || thread?.session?.status === "starting",
      });
      // If the bootstrap command was sent but its acknowledgement was lost,
      // the newly visible thread is proof of effect, not proof that the local
      // receipt was persisted. Replay the same immutable command identity so
      // server deduplication can return the durable receipt.
      const deliveryAction =
        creation !== undefined && thread !== undefined && deliveryState?._tag === "Retrying"
          ? "send"
          : projectedDeliveryAction;
      if (deliveryAction === "wait") {
        continue;
      }
      // The live project shell is preferred for the workspace path, with the
      // snapshot taken at enqueue time as the fallback so a task never dies
      // just because its project shell is not loaded.
      const creationProjectCwd =
        creation !== undefined
          ? (findCreationProject(projects, nextQueuedMessage)?.workspaceRoot ??
            creation.projectCwd ??
            null)
          : null;
      // An incomplete pending task (e.g. worktree mode without a branch) stays
      // queued until the user finishes it in the editor.
      if (deliveryAction === "send" && creation !== undefined) {
        if (!isQueuedThreadCreationSendable(nextQueuedMessage)) {
          continue;
        }
        if (creationProjectCwd === null && shellStatus !== "live") {
          continue;
        }
      }

      beginDispatchingQueuedMessage(nextQueuedMessage.messageId);
      const removeQueuedMessage = (warning: string) =>
        removeThreadOutboxMessage(nextQueuedMessage).then(
          () => true,
          (error) => {
            console.warn(warning, {
              environmentId: nextQueuedMessage.environmentId,
              threadId: nextQueuedMessage.threadId,
              messageId: nextQueuedMessage.messageId,
              error,
            });
            return false;
          },
        );
      // Enqueues publish optimistically before their durable write settles.
      // Confirm the write landed (and the message wasn't rolled back) before
      // sending, so a failed write can never chase an already-delivered turn.
      const delivery = confirmThreadOutboxMessageQueued(nextQueuedMessage).then((queued) => {
        if (!queued) {
          // Rolled back by a failed write; nothing to deliver or retry.
          return true;
        }
        // The guards evaluated before the confirmation await are stale by now:
        // the user may have opened this message in the editor. Re-read that
        // guard and defer to the next drain pass (returning true skips the
        // failure/backoff path) rather than sending a payload being edited.
        if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[nextQueuedMessage.messageId]) {
          return true;
        }
        return deliveryAction === "remove"
          ? removeQueuedMessage("[thread-outbox] failed to remove message for a missing thread")
          : creation !== undefined
            ? creationProjectCwd !== null
              ? sendQueuedCreation(nextQueuedMessage, creation, creationProjectCwd)
              : removeQueuedMessage("[thread-outbox] dropped pending task for a missing project")
            : thread !== undefined
              ? sendQueuedMessage(nextQueuedMessage, thread)
              : Promise.resolve(false);
      });
      void delivery
        .catch((error) => {
          console.warn("[thread-outbox] delivery lifecycle failed", {
            environmentId: nextQueuedMessage.environmentId,
            threadId: nextQueuedMessage.threadId,
            messageId: nextQueuedMessage.messageId,
            error,
          });
          return false;
        })
        .then((sent) => {
          if (sent) {
            retryAttemptRef.current.delete(nextQueuedMessage.messageId);
            retryNotBeforeRef.current.delete(nextQueuedMessage.messageId);
            const pendingTimer = retryTimersRef.current.get(nextQueuedMessage.messageId);
            if (pendingTimer !== undefined) {
              clearTimeout(pendingTimer);
              retryTimersRef.current.delete(nextQueuedMessage.messageId);
            }
            return;
          }

          const retryAttempt = (retryAttemptRef.current.get(nextQueuedMessage.messageId) ?? 0) + 1;
          retryAttemptRef.current.set(nextQueuedMessage.messageId, retryAttempt);
          const retryDelayMs = threadOutboxRetryDelayMs(retryAttempt);
          retryNotBeforeRef.current.set(nextQueuedMessage.messageId, Date.now() + retryDelayMs);
          const pendingTimer = retryTimersRef.current.get(nextQueuedMessage.messageId);
          if (pendingTimer !== undefined) {
            clearTimeout(pendingTimer);
          }
          const retryTimer = setTimeout(() => {
            retryTimersRef.current.delete(nextQueuedMessage.messageId);
            setRetryTick((current) => current + 1);
          }, retryDelayMs);
          retryTimersRef.current.set(nextQueuedMessage.messageId, retryTimer);
        })
        .finally(() => {
          finishDispatchingQueuedMessage(nextQueuedMessage.messageId);
        });
      return;
    }
  }, [
    connectedEnvironments,
    composerDraftsReady,
    deliveryStates,
    dispatchingQueuedMessageId,
    editingQueuedMessageIds,
    projects,
    queuedMessagesByThreadKey,
    retryTick,
    sendQueuedCreation,
    sendQueuedMessage,
    shellStatuses,
    threads,
  ]);
}
