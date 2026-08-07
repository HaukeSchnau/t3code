import {
  type EnvironmentId,
  type MessageId,
  type ModelSelection,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ScopedThreadRef,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import { truncate } from "@t3tools/shared/String";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  collapseExpandedComposerCursor,
  parseStandaloneComposerSlashCommand,
} from "../../composer-logic";
import {
  type ComposerImageAttachment,
  type DraftId,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { readEnvironmentApi } from "../../environmentApi";
import {
  appendTerminalContextsToPrompt,
  formatTerminalContextLabel,
  type TerminalContextDraft,
} from "../../lib/terminalContext";
import { type ElementContextDraft } from "../../lib/elementContext";
import { resolveAppModelSelectionForInstance } from "../../modelSelection";
import { type Project, type ChatMessage, type SessionPhase, type Thread } from "../../types";
import { newCommandId, newDraftId, newMessageId } from "~/lib/utils";
import {
  buildExpiredTerminalContextToastCopy,
  cloneComposerImageForRetry,
  deriveComposerSendState,
  getStartedThreadModelChangeBlockReason,
  readFileAsDataUrl,
  revokeUserMessagePreviewUrls,
} from "../ChatView.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { InlineMessageEditor } from "./InlineMessageEditor";
import { type ChatComposerHandle, type ChatComposerProps } from "./ChatComposer";
import {
  editableTextFromUserMessage,
  hydrateMessageImagesForEdit,
  waitForMessagePrunedFromThread,
} from "./previousMessageEditing";
import { type UserMessageEditingController } from "./MessagesTimeline";
import { type UnifiedSettings } from "@t3tools/contracts/settings";
import { type ExpandedImagePreview } from "./ExpandedImagePreview";

interface UsePreviousMessageEditingInput {
  activeThread: Thread | undefined;
  activeProject: Project | undefined;
  isServerThread: boolean;
  isWorking: boolean;
  isSendBusy: boolean;
  isConnecting: boolean;
  isRevertingCheckpoint: boolean;
  activeEnvironmentUnavailable: unknown;
  environmentId: EnvironmentId;
  routeKind: "server" | "draft";
  routeThreadRef: ScopedThreadRef;
  draftId: DraftId | null;
  activeThreadId: ThreadId | null;
  phase: SessionPhase;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  lockedProvider: ProviderDriverKind | null;
  providerStatuses: ServerProvider[];
  activeUsageLimits: ChatComposerProps["activeUsageLimits"];
  resolvedTheme: "light" | "dark";
  settings: UnifiedSettings;
  keybindings: ChatComposerProps["keybindings"];
  terminalOpen: boolean;
  gitCwd: string | null;
  environmentUnavailableState: ChatComposerProps["environmentUnavailable"];
  composerDraftTarget: ScopedThreadRef | DraftId;
  composerRef: RefObject<ChatComposerHandle | null>;
  promptRef: RefObject<string>;
  composerImagesRef: RefObject<ComposerImageAttachment[]>;
  composerTerminalContextsRef: RefObject<TerminalContextDraft[]>;
  sendInFlightRef: RefObject<boolean>;
  editableUserMessageIds: ReadonlySet<MessageId>;
  setOptimisticUserMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setThreadError: (threadId: ThreadId | null, error: string | null) => void;
  prepareTimelineForOptimisticMessage: () => Promise<void>;
  beginLocalDispatch: (options?: { preparingWorktree?: boolean }) => void;
  resetLocalDispatch: () => void;
  persistThreadSettingsForNextTurn: (input: {
    threadId: ThreadId;
    createdAt: string;
    modelSelection?: ModelSelection;
    runtimeMode: RuntimeMode;
    interactionMode: ProviderInteractionMode;
  }) => Promise<void>;
  scheduleComposerFocus: () => void;
  onInterrupt: () => void;
  onImplementPlanInNewThread: () => void;
  onRespondToApproval: ChatComposerProps["onRespondToApproval"];
  onSelectActivePendingUserInputOption: (questionId: string, optionLabel: string) => void;
  onAdvanceActivePendingUserInput: () => void;
  onPreviousActivePendingUserInputQuestion: () => void;
  onChangeActivePendingUserInputCustomAnswer: (
    questionId: string,
    value: string,
    nextCursor: number,
    expandedCursor: number,
    cursorAdjacentToMention: boolean,
  ) => void;
  getModelDisabledReason: (instanceId: ProviderInstanceId, model: string) => string | null;
  setThreadErrorFromEditor: (threadId: ThreadId | null, error: string | null) => void;
  onExpandImage: (preview: ExpandedImagePreview) => void;
  formatOutgoingPrompt: (params: {
    provider: ProviderDriverKind;
    model: string | null;
    models: ReadonlyArray<ServerProvider["models"][number]>;
    effort: string | null;
    text: string;
  }) => string;
  imageOnlyBootstrapPrompt: string;
}

export interface PreviousMessageEditingState {
  readonly isEditing: boolean;
  readonly isRevertingCheckpoint: boolean;
  readonly timelineController: UserMessageEditingController;
}

export function usePreviousMessageEditing({
  activeThread,
  activeProject,
  isServerThread,
  isWorking,
  isSendBusy,
  isConnecting,
  isRevertingCheckpoint: isExternalRevertingCheckpoint,
  activeEnvironmentUnavailable,
  environmentId,
  routeKind,
  routeThreadRef,
  draftId,
  activeThreadId,
  phase,
  runtimeMode,
  interactionMode,
  lockedProvider,
  providerStatuses,
  activeUsageLimits,
  resolvedTheme,
  settings,
  keybindings,
  terminalOpen,
  gitCwd,
  environmentUnavailableState,
  composerDraftTarget,
  composerRef,
  promptRef,
  composerImagesRef,
  composerTerminalContextsRef,
  sendInFlightRef,
  editableUserMessageIds,
  setOptimisticUserMessages,
  setThreadError,
  prepareTimelineForOptimisticMessage,
  beginLocalDispatch,
  resetLocalDispatch,
  persistThreadSettingsForNextTurn,
  scheduleComposerFocus,
  onInterrupt,
  onImplementPlanInNewThread,
  onRespondToApproval,
  onSelectActivePendingUserInputOption,
  onAdvanceActivePendingUserInput,
  onPreviousActivePendingUserInputQuestion,
  onChangeActivePendingUserInputCustomAnswer,
  getModelDisabledReason,
  setThreadErrorFromEditor,
  onExpandImage,
  formatOutgoingPrompt,
  imageOnlyBootstrapPrompt,
}: UsePreviousMessageEditingInput): PreviousMessageEditingState {
  const setStickyComposerModelSelection = useComposerDraftStore(
    (store) => store.setStickyModelSelection,
  );
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const setComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.setTerminalContexts,
  );
  const setComposerDraftModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const setComposerDraftRuntimeMode = useComposerDraftStore((store) => store.setRuntimeMode);
  const setComposerDraftInteractionMode = useComposerDraftStore(
    (store) => store.setInteractionMode,
  );
  const removeComposerDraftImage = useComposerDraftStore((store) => store.removeImage);
  const clearComposerDraftContent = useComposerDraftStore((store) => store.clearComposerContent);

  const editPromptRef = useRef("");
  const editComposerImagesRef = useRef<ComposerImageAttachment[]>([]);
  const editComposerTerminalContextsRef = useRef<TerminalContextDraft[]>([]);
  const editComposerElementContextsRef = useRef<ElementContextDraft[]>([]);
  const editComposerRef = useRef<ChatComposerHandle | null>(null);
  const activeThreadSnapshotRef = useRef<Thread | undefined>(undefined);
  activeThreadSnapshotRef.current = activeThread;

  const [editingUserMessage, setEditingUserMessage] = useState<{
    messageId: MessageId;
    draftTarget: DraftId;
  } | null>(null);
  const [isPreparingEdit, setIsPreparingEdit] = useState(false);
  const [isSubmittingEdit, setIsSubmittingEdit] = useState(false);
  const [isEditPruningHistory, setIsEditPruningHistory] = useState(false);

  const clearEditDraft = useCallback(
    (draftTarget: DraftId) => {
      const draft = useComposerDraftStore.getState().getComposerDraft(draftTarget);
      for (const image of draft?.images ?? []) {
        removeComposerDraftImage(draftTarget, image.id);
      }
      clearComposerDraftContent(draftTarget);
    },
    [clearComposerDraftContent, removeComposerDraftImage],
  );

  const scheduleEditComposerFocus = useCallback(() => {
    window.requestAnimationFrame(() => {
      editComposerRef.current?.focusAtEnd();
    });
  }, []);

  const resetEditState = useCallback(() => {
    editPromptRef.current = "";
    editComposerImagesRef.current = [];
    editComposerTerminalContextsRef.current = [];
    editComposerElementContextsRef.current = [];
    setEditingUserMessage(null);
  }, []);

  const cancelEditUserMessage = useCallback(() => {
    if (editingUserMessage) {
      clearEditDraft(editingUserMessage.draftTarget);
    }
    resetEditState();
  }, [clearEditDraft, editingUserMessage, resetEditState]);

  const previousEditThreadIdRef = useRef<ThreadId | null>(activeThreadId);
  useEffect(() => {
    if (previousEditThreadIdRef.current === activeThreadId) {
      return;
    }
    previousEditThreadIdRef.current = activeThreadId;
    if (!editingUserMessage) {
      return;
    }
    clearEditDraft(editingUserMessage.draftTarget);
    resetEditState();
  }, [activeThreadId, clearEditDraft, editingUserMessage, resetEditState]);

  const onEditProviderModelSelect = useCallback(
    (instanceId: ProviderInstanceId, model: string) => {
      if (!activeThread || !editingUserMessage) return;
      const entry = providerStatuses.find((snapshot) => snapshot.instanceId === instanceId);
      const resolvedDriverKind = entry?.driver ?? null;
      if (
        lockedProvider !== null &&
        resolvedDriverKind !== null &&
        resolvedDriverKind !== lockedProvider
      ) {
        scheduleEditComposerFocus();
        return;
      }
      if (lockedProvider !== null && activeThread.session?.providerInstanceId) {
        const currentEntry = providerStatuses.find(
          (snapshot) => snapshot.instanceId === activeThread.session?.providerInstanceId,
        );
        if (
          currentEntry?.continuation?.groupKey &&
          entry?.continuation?.groupKey &&
          currentEntry.continuation.groupKey !== entry.continuation.groupKey
        ) {
          scheduleEditComposerFocus();
          return;
        }
      }
      const resolvedModel = resolveAppModelSelectionForInstance(
        instanceId,
        settings,
        providerStatuses,
        model,
      );
      if (!resolvedModel) {
        scheduleEditComposerFocus();
        return;
      }
      const nextModelSelection: ModelSelection = {
        instanceId,
        model: resolvedModel,
      };
      const modelChangeBlockReason = getStartedThreadModelChangeBlockReason({
        providers: providerStatuses,
        hasStartedSession: activeThread.session !== null,
        currentModelSelection: activeThread.modelSelection,
        currentProviderInstanceId: activeThread.session?.providerInstanceId ?? null,
        nextModelSelection,
      });
      if (modelChangeBlockReason) {
        toastManager.add({
          type: "warning",
          title: modelChangeBlockReason.title,
          description: modelChangeBlockReason.description,
        });
        scheduleEditComposerFocus();
        return;
      }
      setComposerDraftModelSelection(editingUserMessage.draftTarget, nextModelSelection);
      setStickyComposerModelSelection(nextModelSelection);
      scheduleEditComposerFocus();
    },
    [
      activeThread,
      editingUserMessage,
      lockedProvider,
      providerStatuses,
      scheduleEditComposerFocus,
      setComposerDraftModelSelection,
      setStickyComposerModelSelection,
      settings,
    ],
  );

  const handleEditRuntimeModeChange = useCallback(
    (nextRuntimeMode: RuntimeMode) => {
      if (!editingUserMessage) return;
      setComposerDraftRuntimeMode(editingUserMessage.draftTarget, nextRuntimeMode);
      scheduleEditComposerFocus();
    },
    [editingUserMessage, scheduleEditComposerFocus, setComposerDraftRuntimeMode],
  );

  const handleEditInteractionModeChange = useCallback(
    (nextInteractionMode: ProviderInteractionMode) => {
      if (!editingUserMessage) return;
      setComposerDraftInteractionMode(editingUserMessage.draftTarget, nextInteractionMode);
      scheduleEditComposerFocus();
    },
    [editingUserMessage, scheduleEditComposerFocus, setComposerDraftInteractionMode],
  );

  const onEditUserMessage = useCallback(
    (messageId: MessageId) => {
      if (
        !activeThread ||
        !isServerThread ||
        isPreparingEdit ||
        isSubmittingEdit ||
        isExternalRevertingCheckpoint ||
        isEditPruningHistory ||
        isWorking
      ) {
        return;
      }
      const message = activeThread.messages.find(
        (entry) => entry.id === messageId && entry.role === "user",
      );
      if (!editableUserMessageIds.has(messageId) || !message) {
        return;
      }

      setIsPreparingEdit(true);
      const draftTarget = newDraftId();
      void (async () => {
        try {
          const images = await hydrateMessageImagesForEdit(message);
          const prompt = editableTextFromUserMessage(message.text);
          editPromptRef.current = prompt;
          editComposerImagesRef.current = images;
          editComposerTerminalContextsRef.current = [];
          setComposerDraftPrompt(draftTarget, prompt);
          addComposerDraftImages(draftTarget, images);
          setComposerDraftTerminalContexts(draftTarget, []);
          setComposerDraftModelSelection(draftTarget, activeThread.modelSelection);
          setComposerDraftRuntimeMode(draftTarget, activeThread.runtimeMode);
          setComposerDraftInteractionMode(draftTarget, activeThread.interactionMode);
          setEditingUserMessage({ messageId, draftTarget });
          scheduleEditComposerFocus();
        } catch (err) {
          clearEditDraft(draftTarget);
          setThreadError(
            activeThread.id,
            err instanceof Error ? err.message : "Failed to prepare this message for editing.",
          );
        } finally {
          setIsPreparingEdit(false);
        }
      })();
    },
    [
      activeThread,
      addComposerDraftImages,
      clearEditDraft,
      editableUserMessageIds,
      isEditPruningHistory,
      isExternalRevertingCheckpoint,
      isPreparingEdit,
      isServerThread,
      isSubmittingEdit,
      isWorking,
      scheduleEditComposerFocus,
      setComposerDraftInteractionMode,
      setComposerDraftModelSelection,
      setComposerDraftPrompt,
      setComposerDraftRuntimeMode,
      setComposerDraftTerminalContexts,
      setThreadError,
    ],
  );

  const onSendEditedMessage = useCallback(
    async (e?: { preventDefault: () => void }) => {
      e?.preventDefault();
      const api = readEnvironmentApi(environmentId);
      if (
        !api ||
        !activeThread ||
        !activeProject ||
        !editingUserMessage ||
        !isServerThread ||
        isSendBusy ||
        isConnecting ||
        activeEnvironmentUnavailable ||
        sendInFlightRef.current
      ) {
        return;
      }
      const sendCtx = editComposerRef.current?.getSendContext();
      if (!sendCtx) return;
      const {
        images: composerImages,
        terminalContexts: composerTerminalContexts,
        selectedProvider: ctxSelectedProvider,
        selectedModel: ctxSelectedModel,
        selectedProviderModels: ctxSelectedProviderModels,
        selectedPromptEffort: ctxSelectedPromptEffort,
        selectedModelSelection: ctxSelectedModelSelection,
      } = sendCtx;
      const promptForSend = editPromptRef.current;
      const {
        trimmedPrompt: trimmed,
        sendableTerminalContexts: sendableComposerTerminalContexts,
        expiredTerminalContextCount,
        hasSendableContent,
      } = deriveComposerSendState({
        prompt: promptForSend,
        imageCount: composerImages.length,
        terminalContexts: composerTerminalContexts,
      });
      const standaloneSlashCommand =
        composerImages.length === 0 && sendableComposerTerminalContexts.length === 0
          ? parseStandaloneComposerSlashCommand(trimmed)
          : null;
      if (standaloneSlashCommand) {
        setComposerDraftInteractionMode(editingUserMessage.draftTarget, standaloneSlashCommand);
        editPromptRef.current = "";
        clearComposerDraftContent(editingUserMessage.draftTarget);
        editComposerRef.current?.resetCursorState();
        scheduleEditComposerFocus();
        return;
      }
      if (!hasSendableContent) {
        if (expiredTerminalContextCount > 0) {
          const toastCopy = buildExpiredTerminalContextToastCopy(
            expiredTerminalContextCount,
            "empty",
          );
          toastManager.add(
            stackedThreadToast({
              type: "warning",
              title: toastCopy.title,
              description: toastCopy.description,
            }),
          );
        }
        return;
      }

      const threadIdForSend = activeThread.id;
      const editDraft =
        useComposerDraftStore.getState().getComposerDraft(editingUserMessage.draftTarget) ?? null;
      const editRuntimeMode = editDraft?.runtimeMode ?? runtimeMode;
      const editInteractionMode = editDraft?.interactionMode ?? interactionMode;
      const composerImagesSnapshot = [...composerImages];
      const composerTerminalContextsSnapshot = [...sendableComposerTerminalContexts];
      const messageTextForSend = appendTerminalContextsToPrompt(
        promptForSend,
        composerTerminalContextsSnapshot,
      );
      const messageIdForSend = newMessageId();
      const messageCreatedAt = new Date().toISOString();
      const outgoingMessageText = formatOutgoingPrompt({
        provider: ctxSelectedProvider,
        model: ctxSelectedModel,
        models: ctxSelectedProviderModels,
        effort: ctxSelectedPromptEffort,
        text: messageTextForSend || imageOnlyBootstrapPrompt,
      });
      const turnAttachmentsPromise = Promise.all(
        composerImagesSnapshot.map(async (image) => ({
          type: "image" as const,
          name: image.name,
          mimeType: image.mimeType,
          sizeBytes: image.sizeBytes,
          dataUrl: await readFileAsDataUrl(image.file),
        })),
      );
      const optimisticAttachments = composerImagesSnapshot.map((image) => ({
        type: "image" as const,
        id: image.id,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        previewUrl: image.previewUrl,
      }));

      sendInFlightRef.current = true;
      setIsSubmittingEdit(true);
      setIsEditPruningHistory(true);
      setThreadError(threadIdForSend, null);

      let historyPruneSucceeded = false;
      let turnStartSucceeded = false;
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.history.prune",
          commandId: newCommandId(),
          threadId: threadIdForSend,
          messageId: editingUserMessage.messageId,
          createdAt: new Date().toISOString(),
        });
        await waitForMessagePrunedFromThread({
          messageId: editingUserMessage.messageId,
          readThread: () => activeThreadSnapshotRef.current,
        });
        historyPruneSucceeded = true;
        setIsEditPruningHistory(false);

        await prepareTimelineForOptimisticMessage();

        setOptimisticUserMessages((existing) => [
          ...existing,
          {
            id: messageIdForSend,
            role: "user",
            text: outgoingMessageText,
            ...(optimisticAttachments.length > 0 ? { attachments: optimisticAttachments } : {}),
            turnId: null,
            createdAt: messageCreatedAt,
            updatedAt: messageCreatedAt,
            streaming: false,
          },
        ]);

        if (expiredTerminalContextCount > 0) {
          const toastCopy = buildExpiredTerminalContextToastCopy(
            expiredTerminalContextCount,
            "omitted",
          );
          toastManager.add(
            stackedThreadToast({
              type: "warning",
              title: toastCopy.title,
              description: toastCopy.description,
            }),
          );
        }

        const firstComposerImageName = composerImagesSnapshot[0]?.name ?? null;
        let titleSeed = trimmed;
        if (!titleSeed) {
          if (firstComposerImageName) {
            titleSeed = `Image: ${firstComposerImageName}`;
          } else if (composerTerminalContextsSnapshot.length > 0) {
            titleSeed = formatTerminalContextLabel(composerTerminalContextsSnapshot[0]!);
          } else {
            titleSeed = activeThread.title;
          }
        }
        const title = truncate(titleSeed);
        const currentThreadAfterRollback = activeThreadSnapshotRef.current;
        if (currentThreadAfterRollback?.messages.length === 0) {
          await api.orchestration.dispatchCommand({
            type: "thread.meta.update",
            commandId: newCommandId(),
            threadId: threadIdForSend,
            title,
          });
        }

        await persistThreadSettingsForNextTurn({
          threadId: threadIdForSend,
          createdAt: messageCreatedAt,
          ...(ctxSelectedModel ? { modelSelection: ctxSelectedModelSelection } : {}),
          runtimeMode: editRuntimeMode,
          interactionMode: editInteractionMode,
        });

        const turnAttachments = await turnAttachmentsPromise;
        beginLocalDispatch({ preparingWorktree: false });
        await api.orchestration.dispatchCommand({
          type: "thread.turn.start",
          commandId: newCommandId(),
          threadId: threadIdForSend,
          message: {
            messageId: messageIdForSend,
            role: "user",
            text: outgoingMessageText,
            attachments: turnAttachments,
          },
          modelSelection: ctxSelectedModelSelection,
          titleSeed: title,
          runtimeMode: editRuntimeMode,
          interactionMode: editInteractionMode,
          createdAt: messageCreatedAt,
        });
        turnStartSucceeded = true;
        clearComposerDraftContent(editingUserMessage.draftTarget);
        resetEditState();
      } catch (err) {
        if (historyPruneSucceeded && !turnStartSucceeded) {
          setOptimisticUserMessages((existing) => {
            const removed = existing.filter((message) => message.id === messageIdForSend);
            for (const message of removed) {
              revokeUserMessagePreviewUrls(message);
            }
            const next = existing.filter((message) => message.id !== messageIdForSend);
            return next.length === existing.length ? existing : next;
          });
          promptRef.current = promptForSend;
          const retryComposerImages = composerImagesSnapshot.map(cloneComposerImageForRetry);
          composerImagesRef.current = retryComposerImages;
          composerTerminalContextsRef.current = composerTerminalContextsSnapshot;
          clearComposerDraftContent(composerDraftTarget);
          setComposerDraftPrompt(composerDraftTarget, promptForSend);
          addComposerDraftImages(composerDraftTarget, retryComposerImages);
          setComposerDraftTerminalContexts(composerDraftTarget, composerTerminalContextsSnapshot);
          composerRef.current?.resetCursorState({
            cursor: collapseExpandedComposerCursor(promptForSend, promptForSend.length),
            prompt: promptForSend,
            detectTrigger: true,
          });
          clearEditDraft(editingUserMessage.draftTarget);
          resetEditState();
          scheduleComposerFocus();
        }
        setThreadError(
          threadIdForSend,
          err instanceof Error ? err.message : "Failed to edit message.",
        );
      } finally {
        sendInFlightRef.current = false;
        setIsSubmittingEdit(false);
        setIsEditPruningHistory(false);
        if (!turnStartSucceeded) {
          resetLocalDispatch();
        }
      }
    },
    [
      activeEnvironmentUnavailable,
      activeProject,
      activeThread,
      addComposerDraftImages,
      beginLocalDispatch,
      clearComposerDraftContent,
      clearEditDraft,
      composerDraftTarget,
      composerImagesRef,
      composerRef,
      composerTerminalContextsRef,
      environmentId,
      editingUserMessage,
      formatOutgoingPrompt,
      imageOnlyBootstrapPrompt,
      interactionMode,
      isConnecting,
      isSendBusy,
      isServerThread,
      persistThreadSettingsForNextTurn,
      prepareTimelineForOptimisticMessage,
      promptRef,
      resetEditState,
      resetLocalDispatch,
      runtimeMode,
      scheduleComposerFocus,
      scheduleEditComposerFocus,
      sendInFlightRef,
      setComposerDraftInteractionMode,
      setComposerDraftPrompt,
      setComposerDraftTerminalContexts,
      setOptimisticUserMessages,
      setThreadError,
    ],
  );

  const renderUserMessageEditor = useCallback(() => {
    if (!editingUserMessage) {
      return null;
    }
    return (
      <InlineMessageEditor
        composerRef={editComposerRef}
        composerDraftTarget={editingUserMessage.draftTarget}
        environmentId={environmentId}
        routeKind={routeKind}
        routeThreadRef={routeThreadRef}
        draftId={draftId}
        activeThreadId={activeThreadId}
        activeThreadEnvironmentId={activeThread?.environmentId}
        activeThread={activeThread}
        isServerThread={isServerThread}
        forceExpandedOnMobile
        projectSelectionRequired={false}
        phase={phase}
        isConnecting={isConnecting}
        isSendBusy={isSendBusy}
        isSubmitting={isSubmittingEdit}
        isPreparing={isPreparingEdit}
        isRevertingCheckpoint={isEditPruningHistory}
        environmentUnavailable={environmentUnavailableState}
        runtimeMode={runtimeMode}
        interactionMode={interactionMode}
        lockedProvider={lockedProvider}
        providerStatuses={providerStatuses}
        activeProjectDefaultModelSelection={activeProject?.defaultModelSelection}
        activeThreadModelSelection={activeThread?.modelSelection}
        activeThreadActivities={activeThread?.activities}
        activeUsageLimits={activeUsageLimits}
        resolvedTheme={resolvedTheme}
        settings={settings}
        keybindings={keybindings}
        terminalOpen={terminalOpen}
        gitCwd={gitCwd}
        promptRef={editPromptRef}
        composerImagesRef={editComposerImagesRef}
        composerTerminalContextsRef={editComposerTerminalContextsRef}
        composerElementContextsRef={editComposerElementContextsRef}
        onSend={onSendEditedMessage}
        onInterrupt={onInterrupt}
        onImplementPlanInNewThread={onImplementPlanInNewThread}
        onRespondToApproval={onRespondToApproval}
        onSelectActivePendingUserInputOption={onSelectActivePendingUserInputOption}
        onAdvanceActivePendingUserInput={onAdvanceActivePendingUserInput}
        onPreviousActivePendingUserInputQuestion={onPreviousActivePendingUserInputQuestion}
        onChangeActivePendingUserInputCustomAnswer={onChangeActivePendingUserInputCustomAnswer}
        onProviderModelSelect={onEditProviderModelSelect}
        getModelDisabledReason={getModelDisabledReason}
        toggleInteractionMode={() => {
          const currentInteractionMode =
            useComposerDraftStore.getState().getComposerDraft(editingUserMessage.draftTarget)
              ?.interactionMode ?? interactionMode;
          handleEditInteractionModeChange(currentInteractionMode === "plan" ? "default" : "plan");
        }}
        handleRuntimeModeChange={handleEditRuntimeModeChange}
        handleInteractionModeChange={handleEditInteractionModeChange}
        focusComposer={() => editComposerRef.current?.focusAtEnd()}
        scheduleComposerFocus={scheduleEditComposerFocus}
        setThreadError={setThreadErrorFromEditor}
        onExpandImage={onExpandImage}
        onCancel={cancelEditUserMessage}
      />
    );
  }, [
    activeProject?.defaultModelSelection,
    activeThread,
    activeThreadId,
    activeUsageLimits,
    cancelEditUserMessage,
    draftId,
    editingUserMessage,
    environmentId,
    environmentUnavailableState,
    getModelDisabledReason,
    gitCwd,
    handleEditInteractionModeChange,
    handleEditRuntimeModeChange,
    interactionMode,
    isConnecting,
    isEditPruningHistory,
    isPreparingEdit,
    isSendBusy,
    isServerThread,
    isSubmittingEdit,
    keybindings,
    lockedProvider,
    onAdvanceActivePendingUserInput,
    onChangeActivePendingUserInputCustomAnswer,
    onEditProviderModelSelect,
    onExpandImage,
    onImplementPlanInNewThread,
    onInterrupt,
    onPreviousActivePendingUserInputQuestion,
    onRespondToApproval,
    onSelectActivePendingUserInputOption,
    onSendEditedMessage,
    phase,
    providerStatuses,
    resolvedTheme,
    routeKind,
    routeThreadRef,
    runtimeMode,
    scheduleEditComposerFocus,
    setThreadErrorFromEditor,
    settings,
    terminalOpen,
  ]);

  const timelineController = useMemo<UserMessageEditingController>(
    () => ({
      editingUserMessageId: editingUserMessage?.messageId ?? null,
      onEditUserMessage,
      renderUserMessageEditor,
    }),
    [editingUserMessage?.messageId, onEditUserMessage, renderUserMessageEditor],
  );

  return {
    isEditing: editingUserMessage !== null,
    isRevertingCheckpoint: isEditPruningHistory,
    timelineController,
  };
}
