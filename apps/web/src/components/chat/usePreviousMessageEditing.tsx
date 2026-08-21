import {
  type MessageId,
  type ModelSelection,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ScopedThreadRef,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useAtomValue } from "@effect/atom-react";
import { projectScriptCwd } from "@t3tools/shared/projectScripts";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { parseStandaloneComposerSlashCommand } from "../../composer-logic";
import {
  type ComposerImageAttachment,
  type DraftId,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { readEnvironmentApi } from "../../environmentApi";
import { type TerminalContextDraft } from "../../lib/terminalContext";
import { type ElementContextDraft } from "../../lib/elementContext";
import { resolveAppModelSelectionForInstance } from "../../modelSelection";
import { derivePhase } from "../../session-logic";
import { type ChatMessage, type Thread } from "../../types";
import { newCommandId, newDraftId, newMessageId } from "~/lib/utils";
import {
  buildExpiredTerminalContextToastCopy,
  cloneComposerImageForRetry,
  deriveLockedProvider,
  getStartedThreadModelChangeBlockReason,
  readFileAsDataUrl,
} from "../ChatView.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { InlineMessageEditor } from "./InlineMessageEditor";
import { type ChatComposerHandle } from "./ChatComposer";
import {
  editableTextFromUserMessage,
  hydrateMessageImagesForEdit,
  runPreviousMessageEditTransaction,
  waitForMessagePrunedFromThread,
} from "./previousMessageEditing";
import { type UserMessageEditingController } from "./MessagesTimeline";
import { type ExpandedImagePreview } from "./ExpandedImagePreview";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useTheme } from "../../hooks/useTheme";
import { useEnvironment } from "../../state/environments";
import { useProject, useProviderUsageLimits, useThread } from "../../state/entities";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../../terminalUiStateStore";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "../../types";
import {
  analyzeThreadTurnDraft,
  formatThreadTurnOutgoingText,
  IMAGE_ONLY_BOOTSTRAP_PROMPT,
  resolveNewThreadSubmissionTitle,
  serializeThreadTurnPrompt,
  threadTurnDraftFromComposer,
  type ThreadTurnDraft,
} from "./ThreadTurnSubmission";

const NOOP = () => undefined;
const NOOP_ASYNC = () => Promise.resolve(undefined);
const EMPTY_PROVIDER_STATUSES: ReadonlyArray<ServerProvider> = [];

interface UsePreviousMessageEditingInput {
  routeThreadRef: ScopedThreadRef;
  draftId: DraftId | null;
  isExternallyBusy: boolean;
  sendInFlightRef: RefObject<boolean>;
  prepareOptimisticMessage: (message: ChatMessage) => Promise<void>;
  removeOptimisticMessage: (messageId: MessageId) => void;
  restorePrimaryComposer: (draft: {
    readonly prompt: string;
    readonly images: ReadonlyArray<ComposerImageAttachment>;
    readonly terminalContexts: ReadonlyArray<TerminalContextDraft>;
  }) => void;
  setThreadError: (threadId: ThreadId | null, error: string | null) => void;
  beginLocalDispatch: (options?: { preparingWorktree?: boolean }) => void;
  resetLocalDispatch: () => void;
  persistThreadSettingsForNextTurn: (input: {
    threadId: ThreadId;
    createdAt: string;
    modelSelection?: ModelSelection;
    runtimeMode: RuntimeMode;
    interactionMode: ProviderInteractionMode;
  }) => Promise<void>;
  onExpandImage: (preview: ExpandedImagePreview) => void;
}

export interface PreviousMessageEditingState {
  readonly isEditing: boolean;
  readonly isRevertingCheckpoint: boolean;
  readonly timelineController: UserMessageEditingController;
}

export function usePreviousMessageEditing({
  routeThreadRef,
  draftId,
  isExternallyBusy,
  sendInFlightRef,
  prepareOptimisticMessage,
  removeOptimisticMessage,
  restorePrimaryComposer,
  setThreadError,
  beginLocalDispatch,
  resetLocalDispatch,
  persistThreadSettingsForNextTurn,
  onExpandImage,
}: UsePreviousMessageEditingInput): PreviousMessageEditingState {
  const environmentId = routeThreadRef.environmentId;
  const activeThread = useThread(routeThreadRef, { waitForShell: draftId !== null }) ?? undefined;
  const activeThreadId = activeThread?.id ?? null;
  const isServerThread = activeThread !== undefined;
  const routeKind = draftId === null ? "server" : "draft";
  const composerDraftTarget: ScopedThreadRef | DraftId = draftId ?? routeThreadRef;
  const activeProjectRef = useMemo(
    () =>
      activeThread ? scopeProjectRef(activeThread.environmentId, activeThread.projectId) : null,
    [activeThread?.environmentId, activeThread?.projectId],
  );
  const activeProject = useProject(activeProjectRef) ?? undefined;
  const environment = useEnvironment(environmentId);
  const activeEnvironmentUnavailable =
    environment !== null && environment.connection.phase !== "connected";
  const environmentUnavailableState = useMemo(
    () =>
      environment && activeEnvironmentUnavailable
        ? { label: environment.label, connection: environment.connection }
        : null,
    [activeEnvironmentUnavailable, environment],
  );
  const settings = useEnvironmentSettings(environmentId);
  const providerStatuses = environment?.serverConfig?.providers ?? EMPTY_PROVIDER_STATUSES;
  const composerProviderStatuses = useMemo(() => [...providerStatuses], [providerStatuses]);
  const providerUsageLimits = useProviderUsageLimits(environmentId);
  const usageLimitsSources = useMemo(
    () =>
      providerUsageLimits.map((entry) => ({
        provider: entry.provider,
        providerInstanceId: entry.providerInstanceId,
        usageLimits: [entry.usageLimits],
        usageHistory: entry.history,
      })),
    [providerUsageLimits],
  );
  const { resolvedTheme } = useTheme();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const terminalOpen = useTerminalUiStateStore(
    (state) =>
      selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen,
  );
  const composerRuntimeMode = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.runtimeMode ?? null,
  );
  const composerInteractionMode = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.interactionMode ?? null,
  );
  const selectedProvider = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.activeProvider ?? null,
  );
  const runtimeMode = composerRuntimeMode ?? activeThread?.runtimeMode ?? DEFAULT_RUNTIME_MODE;
  const interactionMode = settings.planModeEnabled
    ? (composerInteractionMode ?? activeThread?.interactionMode ?? DEFAULT_INTERACTION_MODE)
    : DEFAULT_INTERACTION_MODE;
  const phase = derivePhase(activeThread?.session ?? null);
  const isWorking = phase === "running" || isExternallyBusy;
  const lockedProvider = deriveLockedProvider({
    thread: activeThread,
    selectedProvider,
    threadProvider:
      activeThread?.modelSelection.instanceId ??
      activeProject?.defaultModelSelection?.instanceId ??
      null,
  });
  const editableUserMessageIds = useMemo(
    () =>
      new Set(
        (activeThread?.messages ?? [])
          .filter((message) => message.role === "user")
          .map((message) => message.id),
      ),
    [activeThread?.messages],
  );
  const gitCwd = activeProject
    ? projectScriptCwd({
        project: { cwd: activeProject.workspaceRoot },
        worktreePath: activeThread?.worktreePath ?? null,
      })
    : null;
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

  const getModelDisabledReason = useCallback(
    (instanceId: ProviderInstanceId, model: string) => {
      if (!activeThread) return null;
      const reason = getStartedThreadModelChangeBlockReason({
        providers: providerStatuses,
        hasStartedSession: activeThread.session !== null,
        currentModelSelection: activeThread.modelSelection,
        currentProviderInstanceId: activeThread.session?.providerInstanceId ?? null,
        nextModelSelection: { instanceId, model },
      });
      return reason ? `${reason.description} Start a new thread to use this model.` : null;
    },
    [activeThread, providerStatuses],
  );

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
        isExternallyBusy ||
        activeEnvironmentUnavailable ||
        sendInFlightRef.current
      ) {
        return;
      }
      const sendCtx = editComposerRef.current?.getSendContext();
      if (!sendCtx) return;
      const submissionDraft: ThreadTurnDraft = {
        ...threadTurnDraftFromComposer(sendCtx, {
          previewAnnotations: [],
          reviewComments: [],
        }),
        elementContexts: [],
      };
      const composerImages = submissionDraft.images;
      const promptForSend = editPromptRef.current;
      const submissionAnalysis = analyzeThreadTurnDraft({
        ...submissionDraft,
        prompt: promptForSend,
      });
      const {
        trimmedPrompt: trimmed,
        sendableTerminalContexts: sendableComposerTerminalContexts,
        expiredTerminalContextCount,
        hasSendableContent,
      } = submissionAnalysis;
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
      const submittedDraft = {
        ...submissionDraft,
        prompt: promptForSend,
        terminalContexts: composerTerminalContextsSnapshot,
      };
      const messageIdForSend = newMessageId();
      const messageCreatedAt = new Date().toISOString();
      const outgoingMessageText = formatThreadTurnOutgoingText(
        submittedDraft,
        serializeThreadTurnPrompt(submittedDraft, submissionAnalysis) ||
          IMAGE_ONLY_BOOTSTRAP_PROMPT,
      );
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

      let turnStartSucceeded = false;
      try {
        const result = await runPreviousMessageEditTransaction({
          pruneHistory: async () => {
            await api.orchestration.dispatchCommand({
              type: "thread.history.prune",
              commandId: newCommandId(),
              threadId: threadIdForSend,
              messageId: editingUserMessage.messageId,
              createdAt: new Date().toISOString(),
            });
          },
          waitForPrunedHistory: () =>
            waitForMessagePrunedFromThread({
              messageId: editingUserMessage.messageId,
              readThread: () => activeThreadSnapshotRef.current,
            }),
          onHistoryPruned: () => setIsEditPruningHistory(false),
          submitReplacement: async () => {
            await prepareOptimisticMessage({
              id: messageIdForSend,
              role: "user",
              text: outgoingMessageText,
              ...(optimisticAttachments.length > 0 ? { attachments: optimisticAttachments } : {}),
              turnId: null,
              createdAt: messageCreatedAt,
              updatedAt: messageCreatedAt,
              streaming: false,
            });

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

            const resolvedTitle = resolveNewThreadSubmissionTitle(
              submittedDraft,
              submissionAnalysis,
            );
            const title = resolvedTitle === "New thread" ? activeThread.title : resolvedTitle;
            if (activeThreadSnapshotRef.current?.messages.length === 0) {
              await api.orchestration.dispatchCommand({
                type: "thread.meta.update",
                commandId: newCommandId(),
                threadId: threadIdForSend,
                title,
                titleMode: "automatic",
              });
            }

            await persistThreadSettingsForNextTurn({
              threadId: threadIdForSend,
              createdAt: messageCreatedAt,
              ...(submittedDraft.selectedModel
                ? { modelSelection: submittedDraft.selectedModelSelection }
                : {}),
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
              modelSelection: submittedDraft.selectedModelSelection,
              titleSeed: title,
              runtimeMode: editRuntimeMode,
              interactionMode: editInteractionMode,
              createdAt: messageCreatedAt,
            });
            clearComposerDraftContent(editingUserMessage.draftTarget);
            resetEditState();
          },
          onReplacementFailed: () => {
            removeOptimisticMessage(messageIdForSend);
            const retryComposerImages = composerImagesSnapshot.map(cloneComposerImageForRetry);
            restorePrimaryComposer({
              prompt: promptForSend,
              images: retryComposerImages,
              terminalContexts: composerTerminalContextsSnapshot,
            });
            clearEditDraft(editingUserMessage.draftTarget);
            resetEditState();
          },
        });
        turnStartSucceeded = result.kind === "delivered";
        if (result.kind === "failed") {
          setThreadError(
            threadIdForSend,
            result.error instanceof Error ? result.error.message : "Failed to edit message.",
          );
        }
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
      beginLocalDispatch,
      clearComposerDraftContent,
      clearEditDraft,
      environmentId,
      editingUserMessage,
      interactionMode,
      isExternallyBusy,
      isServerThread,
      persistThreadSettingsForNextTurn,
      prepareOptimisticMessage,
      removeOptimisticMessage,
      resetEditState,
      resetLocalDispatch,
      restorePrimaryComposer,
      runtimeMode,
      scheduleEditComposerFocus,
      sendInFlightRef,
      setComposerDraftInteractionMode,
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
        isConnecting={false}
        isSendBusy={isExternallyBusy}
        isSubmitting={isSubmittingEdit}
        isPreparing={isPreparingEdit}
        isRevertingCheckpoint={isEditPruningHistory}
        environmentUnavailable={environmentUnavailableState}
        runtimeMode={runtimeMode}
        interactionMode={interactionMode}
        lockedProvider={lockedProvider}
        providerStatuses={composerProviderStatuses}
        activeProjectDefaultModelSelection={activeProject?.defaultModelSelection}
        activeThreadModelSelection={activeThread?.modelSelection}
        activeThreadActivities={activeThread?.activities}
        usageLimitsSources={usageLimitsSources}
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
        onInterrupt={NOOP}
        onImplementPlanInNewThread={NOOP}
        onRespondToApproval={NOOP_ASYNC}
        onSelectActivePendingUserInputOption={NOOP}
        onAdvanceActivePendingUserInput={NOOP}
        onPreviousActivePendingUserInputQuestion={NOOP}
        onChangeActivePendingUserInputCustomAnswer={NOOP}
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
        setThreadError={setThreadError}
        onExpandImage={onExpandImage}
        onCancel={cancelEditUserMessage}
      />
    );
  }, [
    activeProject?.defaultModelSelection,
    activeThread,
    activeThreadId,
    usageLimitsSources,
    cancelEditUserMessage,
    composerProviderStatuses,
    draftId,
    editingUserMessage,
    environmentId,
    environmentUnavailableState,
    getModelDisabledReason,
    gitCwd,
    handleEditInteractionModeChange,
    handleEditRuntimeModeChange,
    interactionMode,
    isEditPruningHistory,
    isExternallyBusy,
    isPreparingEdit,
    isServerThread,
    isSubmittingEdit,
    keybindings,
    lockedProvider,
    onEditProviderModelSelect,
    onExpandImage,
    onSendEditedMessage,
    phase,
    providerStatuses,
    resolvedTheme,
    routeKind,
    routeThreadRef,
    runtimeMode,
    scheduleEditComposerFocus,
    setThreadError,
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
