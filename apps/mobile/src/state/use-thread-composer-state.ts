import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert } from "react-native";
import * as Cause from "effect/Cause";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import {
  codexFeedbackMessage,
  parseCodexFeedbackCommand,
  submitCodexFeedback,
  type CodexFeedbackSubmission,
} from "@t3tools/client-runtime/state/threads";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { deriveActiveWorkStartedAt } from "@t3tools/shared/orchestrationTiming";

import { makeQueuedMessageMetadata } from "../lib/commandMetadata";
import { isModelSelectionUnavailable } from "../lib/modelOptions";
import { resolveProviderInteractionMode } from "../features/threads/legacy-plan-mode";
import {
  convertPastedImagesToAttachments,
  pasteComposerClipboard,
  pickComposerImages,
} from "../lib/composerImages";
import type { DraftComposerImageAttachment } from "../lib/composerImages";
import { scopedThreadKey } from "../lib/scopedEntities";
import { copyTextWithHaptic } from "../lib/copyTextWithHaptic";
import { buildThreadFeed } from "../lib/threadActivity";
import { appAtomRegistry } from "../state/atom-registry";
import {
  appendComposerDraftAttachments,
  appendComposerDraftText,
  clearComposerDraftContent,
  clearComposerDraft,
  composerDraftsAtom,
  ensureComposerDraftsLoaded,
  getComposerDraftSnapshot,
  mergeComposerDraftContent,
  removeComposerDraftAttachment,
  replaceComposerDraftAttachments,
  setComposerDraftText,
  setComposerDraftQueuedEdit,
  updateComposerDraftSettings,
  useComposerDraft,
} from "./use-composer-drafts";
import { setPendingConnectionError } from "../state/use-remote-environment-registry";
import { useSelectedThreadDetail } from "../state/use-thread-detail";
import { useThreadSelection } from "../state/use-thread-selection";
import { enqueueThreadOutboxMessage, threadOutboxManager } from "./thread-outbox";
import {
  holdEditingQueuedMessage,
  releaseEditingQueuedMessage,
  useThreadOutboxDeliveryStates,
  useThreadOutboxMessages,
} from "./use-thread-outbox";
import { presentLocalIntent } from "../features/threads/trainNetworkPresentation";
import { threadEnvironment } from "./threads";
import { useAtomCommand } from "./use-atom-command";

export function appendReviewCommentToDraft(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly text: string;
  readonly attachments?: ReadonlyArray<DraftComposerImageAttachment>;
}): void {
  const threadKey = scopedThreadKey(input.environmentId, input.threadId);
  const existing = appAtomRegistry.get(composerDraftsAtom)[threadKey]?.text ?? "";
  const separator = existing.trim().length > 0 && !existing.endsWith("\n") ? "\n\n" : "";
  setComposerDraftText(threadKey, `${existing}${separator}${input.text}`);
  if (input.attachments && input.attachments.length > 0) {
    appendComposerDraftAttachments(threadKey, input.attachments);
  }
}

export function useThreadDraftForThread(input: {
  readonly environmentId?: EnvironmentId;
  readonly threadId?: ThreadId;
}) {
  const threadKey =
    input.environmentId && input.threadId
      ? scopedThreadKey(input.environmentId, input.threadId)
      : null;
  const draft = useComposerDraft(threadKey);

  return {
    draftMessage: draft.text,
    draftAttachments: draft.attachments,
  };
}

export function useThreadComposerState() {
  const { selectedThread: selectedThreadShell, selectedEnvironmentRuntime } = useThreadSelection();
  const selectedThreadDetail = useSelectedThreadDetail();
  const composerDrafts = useAtomValue(composerDraftsAtom);
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  const outboxDeliveryStates = useThreadOutboxDeliveryStates();
  const [feedbackSubmissionsByThreadKey, setFeedbackSubmissionsByThreadKey] = useState<
    Record<string, ReadonlyArray<CodexFeedbackSubmission>>
  >({});
  const uploadThreadFeedback = useAtomCommand(threadEnvironment.uploadFeedback, {
    reportFailure: false,
  });
  useEffect(() => {
    ensureComposerDraftsLoaded();
  }, []);

  const selectedThreadKey = selectedThreadShell
    ? scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id)
    : null;
  const selectedThreadQueuedMessages = useMemo(
    () => (selectedThreadKey ? (queuedMessagesByThreadKey[selectedThreadKey] ?? []) : []),
    [queuedMessagesByThreadKey, selectedThreadKey],
  );
  const selectedThreadFeed = useMemo(() => {
    if (!selectedThreadDetail) {
      return [];
    }
    const submissions = selectedThreadKey
      ? (feedbackSubmissionsByThreadKey[selectedThreadKey] ?? [])
      : [];
    return buildThreadFeed(selectedThreadDetail, {
      localMessages: submissions.flatMap((submission) =>
        submission.status === "interrupted"
          ? []
          : [codexFeedbackMessage(submission), codexFeedbackMessage(submission, "assistant")],
      ),
    });
  }, [feedbackSubmissionsByThreadKey, selectedThreadDetail, selectedThreadKey]);

  const selectedDraft = selectedThreadKey ? composerDrafts[selectedThreadKey] : null;
  const editingQueuedMessageId = selectedDraft?.editingQueuedMessageId ?? null;
  const draftMessage = selectedDraft?.text ?? "";
  const draftAttachments = selectedDraft?.attachments ?? [];
  const selectedThreadQueueCount = selectedThreadQueuedMessages.length;
  const selectedThreadRejectedMessages = selectedThreadQueuedMessages.filter(
    (message) => outboxDeliveryStates[message.commandId]?._tag === "Rejected",
  );
  const selectedThreadQueueStatus = (() => {
    if (selectedThreadRejectedMessages.length > 0) {
      return `${selectedThreadRejectedMessages.length} locally saved message${selectedThreadRejectedMessages.length === 1 ? "" : "s"} could not send`;
    }
    if (
      selectedThreadQueuedMessages.some(
        (message) => outboxDeliveryStates[message.commandId]?._tag === "Delivering",
      )
    ) {
      return "Sending from this device…";
    }
    if (
      selectedThreadQueuedMessages.some(
        (message) => outboxDeliveryStates[message.commandId]?._tag === "Retrying",
      )
    ) {
      return "Saved on this device · retrying automatically";
    }
    return `${selectedThreadQueueCount} message${selectedThreadQueueCount === 1 ? "" : "s"} saved on this device`;
  })();
  const selectedThreadQueuedIntents = useMemo(
    () =>
      selectedThreadQueuedMessages.map((message) => ({
        message,
        presentation: presentLocalIntent(outboxDeliveryStates[message.commandId]),
      })),
    [outboxDeliveryStates, selectedThreadQueuedMessages],
  );
  const discardRejectedMessages = useCallback(async () => {
    for (const message of selectedThreadRejectedMessages) {
      await threadOutboxManager.discardRejected(message);
    }
  }, [selectedThreadRejectedMessages]);
  const selectedThread = selectedThreadDetail ?? selectedThreadShell;
  const modelSelection = selectedDraft?.modelSelection ?? selectedThread?.modelSelection ?? null;
  const runtimeMode = selectedDraft?.runtimeMode ?? selectedThread?.runtimeMode ?? null;
  const selectedProvider = selectedEnvironmentRuntime?.serverConfig?.providers.find(
    (provider) => provider.instanceId === modelSelection?.instanceId,
  );
  const interactionMode = selectedThread
    ? resolveProviderInteractionMode(
        selectedProvider,
        selectedDraft?.interactionMode ?? selectedThread.interactionMode,
      )
    : null;

  const selectedThreadSessionActivity = useMemo(() => {
    const selectedThread = selectedThreadDetail ?? selectedThreadShell;
    if (!selectedThread?.session) {
      return null;
    }

    return {
      orchestrationStatus: selectedThread.session.status,
      activeTurnId: selectedThread.session.activeTurnId ?? undefined,
    };
  }, [selectedThreadDetail, selectedThreadShell]);

  const activeWorkStartedAt = useMemo(() => {
    const selectedThread = selectedThreadDetail ?? selectedThreadShell;
    if (!selectedThread) {
      return null;
    }

    return deriveActiveWorkStartedAt(
      selectedThread.latestTurn,
      selectedThreadSessionActivity,
      null,
    );
  }, [selectedThreadDetail, selectedThreadSessionActivity, selectedThreadShell]);

  const onSendMessage = useCallback(async () => {
    if (!selectedThreadShell) {
      return null;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const draft = getComposerDraftSnapshot(threadKey);
    const thread = selectedThreadDetail ?? selectedThreadShell;
    const text = draft.text.trim();
    const attachments = draft.attachments;
    if (text.length === 0 && attachments.length === 0) {
      return null;
    }

    const modelSelection = draft.modelSelection ?? thread.modelSelection;
    const serverConfig = selectedEnvironmentRuntime?.serverConfig;
    if (
      selectedEnvironmentRuntime?.connectionState === "connected" &&
      isModelSelectionUnavailable(serverConfig, modelSelection)
    ) {
      Alert.alert(
        "Antigravity model unavailable",
        "Open model settings to finish setup or choose another model.",
      );
      return null;
    }
    const provider = serverConfig?.providers.find(
      (entry) => entry.instanceId === modelSelection.instanceId,
    );
    const feedbackCommand =
      attachments.length === 0 &&
      (provider?.driver === "codex" || thread.session?.providerName === "codex")
        ? parseCodexFeedbackCommand(text)
        : null;
    if (feedbackCommand) {
      if (thread.session === null) {
        Alert.alert("Start a Codex thread first", "Send a message before you submit feedback.");
        return null;
      }
      const metadata = makeQueuedMessageMetadata();
      const result = await submitCodexFeedback({
        submission: {
          id: MessageId.make(metadata.messageId),
          command: text,
          createdAt: metadata.createdAt,
        },
        clearDraft: () => clearComposerDraftContent(threadKey),
        onUpdate: (submission) => {
          setFeedbackSubmissionsByThreadKey((current) => {
            const existing = current[threadKey] ?? [];
            const found = existing.some((entry) => entry.id === submission.id);
            return {
              ...current,
              [threadKey]: found
                ? existing.map((entry) => (entry.id === submission.id ? submission : entry))
                : [...existing, submission],
            };
          });
        },
        upload: () =>
          uploadThreadFeedback({
            environmentId: selectedThreadShell.environmentId,
            input: {
              threadId: selectedThreadShell.id,
              ...feedbackCommand,
            },
          }),
      });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) {
          return null;
        }
        const error = Cause.squash(result.cause);
        Alert.alert(
          "Could not send feedback to OpenAI",
          error instanceof Error ? error.message : "An error occurred.",
        );
        return null;
      }
      const feedbackId = result.value.feedbackId;
      Alert.alert("Feedback sent to OpenAI", `Thread ID: ${feedbackId}`, [
        { text: "OK", style: "cancel" },
        {
          text: "Copy ID",
          onPress: () => copyTextWithHaptic(feedbackId, { target: "Codex feedback thread ID" }),
        },
      ]);
      return null;
    }

    const metadata = makeQueuedMessageMetadata();
    const messageId = MessageId.make(metadata.messageId);
    const editingMessage = selectedThreadQueuedMessages.find(
      (message) => message.messageId === editingQueuedMessageId,
    );
    if (editingQueuedMessageId !== null && !editingMessage) {
      setPendingConnectionError(
        "The original saved message is no longer available. Cancel this edit before sending.",
      );
      return null;
    }
    if (editingMessage) {
      try {
        const updated = await threadOutboxManager.update(editingMessage, {
          ...editingMessage,
          messageId,
          commandId: CommandId.make(metadata.commandId),
          text,
          attachments,
          modelSelection: draft.modelSelection ?? thread.modelSelection,
          runtimeMode: draft.runtimeMode ?? thread.runtimeMode,
          interactionMode: draft.interactionMode ?? thread.interactionMode,
          createdAt: metadata.createdAt,
        });
        if (!updated) return null;
        setComposerDraftQueuedEdit(threadKey, undefined);
        releaseEditingQueuedMessage(editingMessage.messageId);
        clearComposerDraftContent(threadKey);
        return messageId;
      } catch (error) {
        setPendingConnectionError(
          error instanceof Error ? error.message : "Failed to update the queued message.",
        );
        return null;
      }
    }

    // Enqueue publishes the queued atom synchronously (the durable write
    // happens behind it), so clearing the draft here gives send feedback on
    // the tap frame instead of after file I/O. If the write fails the message
    // is rolled out of the queue and the content is merged back into the
    // draft, preserving anything typed since.
    const enqueuePromise = enqueueThreadOutboxMessage({
      environmentId: selectedThreadShell.environmentId,
      threadId: selectedThreadShell.id,
      messageId,
      commandId: CommandId.make(metadata.commandId),
      text,
      attachments,
      modelSelection,
      runtimeMode: draft.runtimeMode ?? thread.runtimeMode,
      interactionMode: resolveProviderInteractionMode(
        provider,
        draft.interactionMode ?? thread.interactionMode,
      ),
      createdAt: metadata.createdAt,
    });
    clearComposerDraftContent(threadKey);
    enqueuePromise.catch((error: unknown) => {
      // Restore text via merge (idempotent) but attachments via the uncapped
      // append: the merge path slots existing attachments first and truncates
      // at the send limit, which would silently drop this message's images if
      // the user attached new ones while the write was in flight.
      void mergeComposerDraftContent(threadKey, { text, attachments: [] });
      appendComposerDraftAttachments(threadKey, attachments);
      setPendingConnectionError(
        error instanceof Error ? error.message : "Failed to save the queued message.",
      );
    });
    return messageId;
  }, [
    editingQueuedMessageId,
    selectedEnvironmentRuntime?.serverConfig?.providers,
    selectedThreadDetail,
    selectedThreadQueuedMessages,
    selectedThreadShell,
    uploadThreadFeedback,
  ]);

  const editPendingMessage = useCallback(
    (messageId: MessageId) => {
      if (!selectedThreadKey) return;
      const message = selectedThreadQueuedMessages.find(
        (candidate) => candidate.messageId === messageId,
      );
      if (!message || outboxDeliveryStates[message.commandId]?._tag !== "Pending") return;
      const draft = getComposerDraftSnapshot(selectedThreadKey);
      if (draft.text.trim().length > 0 || draft.attachments.length > 0) {
        setPendingConnectionError(
          "Send or clear the current draft before editing a saved message.",
        );
        return;
      }
      holdEditingQueuedMessage(message.messageId);
      setComposerDraftQueuedEdit(selectedThreadKey, message.messageId);
      setComposerDraftText(selectedThreadKey, message.text);
      replaceComposerDraftAttachments(selectedThreadKey, message.attachments);
      updateComposerDraftSettings(selectedThreadKey, {
        modelSelection: message.modelSelection,
        runtimeMode: message.runtimeMode,
        interactionMode: message.interactionMode,
      });
    },
    [outboxDeliveryStates, selectedThreadKey, selectedThreadQueuedMessages],
  );

  const cancelPendingMessage = useCallback(
    async (messageId: MessageId) => {
      const message = selectedThreadQueuedMessages.find(
        (candidate) => candidate.messageId === messageId,
      );
      if (!message || outboxDeliveryStates[message.commandId]?._tag !== "Pending") return;
      await threadOutboxManager.remove(message);
      if (editingQueuedMessageId === messageId && selectedThreadKey) {
        clearComposerDraft(selectedThreadKey);
        releaseEditingQueuedMessage(messageId);
      }
    },
    [editingQueuedMessageId, outboxDeliveryStates, selectedThreadKey, selectedThreadQueuedMessages],
  );

  const discardRejectedMessage = useCallback(
    async (messageId: MessageId) => {
      const message = selectedThreadQueuedMessages.find(
        (candidate) => candidate.messageId === messageId,
      );
      if (!message || outboxDeliveryStates[message.commandId]?._tag !== "Rejected") return;
      await threadOutboxManager.discardRejected(message);
    },
    [outboxDeliveryStates, selectedThreadQueuedMessages],
  );

  const cancelQueuedMessageEdit = useCallback(() => {
    if (editingQueuedMessageId === null || selectedThreadKey === null) return;
    clearComposerDraft(selectedThreadKey);
    releaseEditingQueuedMessage(editingQueuedMessageId);
  }, [editingQueuedMessageId, selectedThreadKey]);

  const onChangeDraftMessage = useCallback(
    (value: string) => {
      if (!selectedThreadShell) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      setComposerDraftText(threadKey, value);
    },
    [selectedThreadShell],
  );

  const onPickDraftImages = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const result = await pickComposerImages({
      existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
    });
    if (result.images.length > 0) {
      appendComposerDraftAttachments(threadKey, result.images);
    }
    if (result.error) {
      setPendingConnectionError(result.error);
    }
  }, [composerDrafts, selectedThreadShell]);

  const onPasteIntoDraft = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const result = await pasteComposerClipboard({
      existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
    });
    if (result.images.length > 0) {
      appendComposerDraftAttachments(threadKey, result.images);
    }
    if (result.text) {
      appendComposerDraftText(threadKey, result.text);
    }
    if (result.error) {
      setPendingConnectionError(result.error);
    }
  }, [composerDrafts, selectedThreadShell]);

  const onNativePasteImages = useCallback(
    async (uris: ReadonlyArray<string>) => {
      if (!selectedThreadShell || uris.length === 0) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      try {
        const images = await convertPastedImagesToAttachments({
          uris,
          existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
        });
        if (images.length > 0) {
          appendComposerDraftAttachments(threadKey, images);
        }
      } catch (error) {
        console.error("[native paste] error converting images", {
          environmentId: selectedThreadShell.environmentId,
          threadId: selectedThreadShell.id,
          uriCount: uris.length,
          ...safeErrorLogAttributes(error),
        });
      }
    },
    [composerDrafts, selectedThreadShell],
  );

  const onRemoveDraftImage = useCallback(
    (imageId: string) => {
      if (!selectedThreadShell) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      removeComposerDraftAttachment(threadKey, imageId);
    },
    [selectedThreadShell],
  );

  const onUpdateModelSelection = useCallback(
    (value: ModelSelection) => {
      if (!selectedThreadKey) {
        return;
      }
      const provider = selectedEnvironmentRuntime?.serverConfig?.providers.find(
        (candidate) => candidate.instanceId === value.instanceId,
      );
      updateComposerDraftSettings(selectedThreadKey, {
        modelSelection: value,
        ...(provider?.showInteractionModeToggle === false
          ? { interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE }
          : {}),
      });
    },
    [selectedEnvironmentRuntime?.serverConfig, selectedThreadKey],
  );

  const onUpdateRuntimeMode = useCallback(
    (value: RuntimeMode) => {
      if (!selectedThreadKey) {
        return;
      }
      updateComposerDraftSettings(selectedThreadKey, { runtimeMode: value });
    },
    [selectedThreadKey],
  );

  const onUpdateInteractionMode = useCallback(
    (value: ProviderInteractionMode) => {
      if (!selectedThreadKey) {
        return;
      }
      const modelSelection =
        getComposerDraftSnapshot(selectedThreadKey).modelSelection ??
        selectedThread?.modelSelection;
      const provider = selectedEnvironmentRuntime?.serverConfig?.providers.find(
        (candidate) => candidate.instanceId === modelSelection?.instanceId,
      );
      updateComposerDraftSettings(selectedThreadKey, {
        interactionMode: resolveProviderInteractionMode(provider, value),
      });
    },
    [selectedEnvironmentRuntime?.serverConfig, selectedThread?.modelSelection, selectedThreadKey],
  );

  return {
    selectedThreadFeed,
    selectedThreadQueueCount,
    selectedThreadQueueStatus,
    selectedThreadRejectedCount: selectedThreadRejectedMessages.length,
    selectedThreadQueuedIntents,
    editingQueuedMessageId,
    editPendingMessage,
    cancelPendingMessage,
    discardRejectedMessage,
    cancelQueuedMessageEdit,
    discardRejectedMessages,
    activeWorkStartedAt,
    draftMessage,
    draftAttachments,
    modelSelection,
    runtimeMode,
    interactionMode,
    onChangeDraftMessage,
    onPickDraftImages,
    onPasteIntoDraft,
    onNativePasteImages,
    onRemoveDraftImage,
    onSendMessage,
    onUpdateModelSelection,
    onUpdateRuntimeMode,
    onUpdateInteractionMode,
  };
}
