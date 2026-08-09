import type { DurableClientCommand } from "@t3tools/client-runtime/operations/command-outbox";
import {
  DEFAULT_MODEL,
  type EnvironmentId,
  type MessageId,
  type ModelSelection,
  type ProjectId,
  type ProviderDriverKind,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import {
  applyClaudePromptEffortPrefix,
  createModelSelection,
  resolvePromptInjectedEffort,
} from "@t3tools/shared/model";
import { truncate } from "@t3tools/shared/String";

import type { ComposerImageAttachment } from "../../composerDraftStore";
import { shouldClearComposerAfterDurableEnqueue } from "../../durableCommandOutbox";
import {
  appendElementContextsToPrompt,
  formatElementContextLabel,
  type ElementContextDraft,
} from "../../lib/elementContext";
import { appendPreviewAnnotationPrompt } from "../../lib/previewAnnotation";
import {
  appendTerminalContextsToPrompt,
  formatTerminalContextLabel,
  type TerminalContextDraft,
} from "../../lib/terminalContext";
import {
  appendReviewCommentsToPrompt,
  type ReviewCommentContext,
} from "../../reviewCommentContext";
import type { ChatMessage } from "../../types";
import { getProviderModelCapabilities } from "../../providerModels";
import {
  cloneComposerImageForRetry,
  deriveComposerSendState,
  readFileAsDataUrl,
} from "../ChatView.logic";
import type { ChatComposerHandle } from "./ChatComposer";

export const IMAGE_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]";

type ComposerSendContext = ReturnType<ChatComposerHandle["getSendContext"]>;
type TurnAttachment = DurableClientCommand["message"]["attachments"][number];

export interface ThreadTurnDraft {
  readonly prompt: string;
  readonly images: ReadonlyArray<ComposerImageAttachment>;
  readonly terminalContexts: ReadonlyArray<TerminalContextDraft>;
  readonly elementContexts: ReadonlyArray<ElementContextDraft>;
  readonly previewAnnotations: ComposerSendContext["previewAnnotations"];
  readonly reviewComments: ReadonlyArray<ReviewCommentContext>;
  readonly selectedProvider: ProviderDriverKind;
  readonly selectedModel: string | null;
  readonly selectedProviderModels: ReadonlyArray<ServerProvider["models"][number]>;
  readonly selectedPromptEffort: string | null;
  readonly selectedModelSelection: ModelSelection;
}

export interface ThreadTurnDraftAnalysis {
  readonly trimmedPrompt: string;
  readonly sendableTerminalContexts: ReadonlyArray<TerminalContextDraft>;
  readonly expiredTerminalContextCount: number;
  readonly hasSendableContent: boolean;
}

export interface ThreadComposerRevision {
  readonly prompt: string;
  readonly imageIds: ReadonlyArray<string>;
  readonly terminalContexts: ReadonlyArray<TerminalContextDraft>;
  readonly elementContexts: ReadonlyArray<ElementContextDraft>;
  readonly previewAnnotations: ComposerSendContext["previewAnnotations"];
  readonly reviewComments: ReadonlyArray<ReviewCommentContext>;
}

export interface ThreadTurnSubmissionTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly threadCreatedAt: string;
  readonly threadWorktreePath: string | null;
  readonly projectId: ProjectId;
  readonly projectWorkspaceRoot: string;
  readonly projectDefaultModelSelection: ModelSelection | null | undefined;
  readonly isServerThread: boolean;
  readonly isLocalDraftThread: boolean;
  readonly isFirstMessage: boolean;
  readonly queue: boolean;
  readonly prepareWorkspace: boolean;
  readonly activeBranch: string | null;
  readonly baseRevision: string | null;
  readonly startFromOrigin: boolean;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

export interface PreparedThreadTurnSubmission {
  readonly analysis: ThreadTurnDraftAnalysis;
  readonly command: DurableClientCommand;
  readonly composerRevision: ThreadComposerRevision;
  readonly draft: ThreadTurnDraft;
  readonly messageId: MessageId;
  readonly optimisticMessage: ChatMessage;
  readonly preparingWorkspace: boolean;
  readonly queue: boolean;
  readonly title: string;
}

export interface ThreadTurnDeliveryAdapter {
  readonly deliver: (environmentId: EnvironmentId, command: DurableClientCommand) => Promise<void>;
}

export interface ThreadTurnComposerLifecycle {
  readonly clearOnSuccess: "always" | "if-current";
  readonly readCurrentRevision: () => ThreadComposerRevision;
  readonly clear: () => void;
  readonly restore?: (draft: ThreadTurnDraft) => void;
}

export interface ThreadTurnSubmissionLifecycle {
  readonly beforeTransaction?: (prepared: PreparedThreadTurnSubmission) => Promise<void> | void;
  readonly begin?: (input: { readonly preparingWorkspace: boolean }) => void;
  readonly prepared?: (prepared: PreparedThreadTurnSubmission) => void;
  readonly updateTitle?: (title: string) => Promise<void>;
  readonly persistSettings?: (input: {
    readonly threadId: ThreadId;
    readonly createdAt: string;
    readonly modelSelection?: ModelSelection;
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: ProviderInteractionMode;
  }) => Promise<void>;
  readonly beforeStartDelivery?: () => void;
  readonly addOptimistic?: (message: ChatMessage, phase: "prepared" | "start-delivered") => void;
  readonly removeOptimistic?: (messageId: MessageId) => void;
  readonly delivered?: (prepared: PreparedThreadTurnSubmission) => void;
  readonly failed?: (error: unknown, prepared: PreparedThreadTurnSubmission) => void;
  readonly settled?: (succeeded: boolean, prepared: PreparedThreadTurnSubmission) => void;
  readonly expiredContextsOmitted?: (count: number) => void;
}

export interface SubmitThreadTurnInput {
  readonly draft: ThreadTurnDraft;
  readonly analysis?: ThreadTurnDraftAnalysis;
  readonly target: ThreadTurnSubmissionTarget;
  readonly title: string;
  readonly delivery: ThreadTurnDeliveryAdapter;
  readonly composer: ThreadTurnComposerLifecycle;
  readonly lifecycle?: ThreadTurnSubmissionLifecycle;
  readonly formatOutgoingText?: (draft: ThreadTurnDraft, text: string) => string;
  readonly readAttachment?: (file: File) => Promise<string>;
  readonly makeCommandId: () => DurableClientCommand["commandId"];
  readonly makeMessageId: () => MessageId;
  readonly now: () => string;
}

export type SubmitThreadTurnResult =
  | { readonly kind: "empty"; readonly analysis: ThreadTurnDraftAnalysis }
  | { readonly kind: "delivered"; readonly prepared: PreparedThreadTurnSubmission }
  | {
      readonly kind: "failed";
      readonly error: unknown;
      readonly prepared: PreparedThreadTurnSubmission;
    };

export function threadTurnDraftFromComposer(
  sendContext: ComposerSendContext,
  overrides: Partial<
    Pick<ThreadTurnDraft, "images" | "previewAnnotations" | "reviewComments">
  > = {},
): ThreadTurnDraft {
  return {
    prompt: sendContext.prompt,
    images: overrides.images ?? sendContext.images,
    terminalContexts: sendContext.terminalContexts,
    elementContexts: sendContext.elementContexts,
    previewAnnotations: overrides.previewAnnotations ?? sendContext.previewAnnotations,
    reviewComments: overrides.reviewComments ?? sendContext.reviewComments,
    selectedProvider: sendContext.selectedProvider,
    selectedModel: sendContext.selectedModel,
    selectedProviderModels: sendContext.selectedProviderModels,
    selectedPromptEffort: sendContext.selectedPromptEffort,
    selectedModelSelection: sendContext.selectedModelSelection,
  };
}

export function analyzeThreadTurnDraft(draft: ThreadTurnDraft): ThreadTurnDraftAnalysis {
  return deriveComposerSendState({
    prompt: draft.prompt,
    imageCount: draft.images.length,
    terminalContexts: draft.terminalContexts,
    elementContextCount:
      draft.elementContexts.length + draft.previewAnnotations.length + draft.reviewComments.length,
  });
}

export function threadComposerRevision(
  draft: Pick<
    ThreadTurnDraft,
    | "prompt"
    | "images"
    | "terminalContexts"
    | "elementContexts"
    | "previewAnnotations"
    | "reviewComments"
  >,
): ThreadComposerRevision {
  return {
    prompt: draft.prompt,
    imageIds: draft.images.map((image) => image.id),
    terminalContexts: draft.terminalContexts,
    elementContexts: draft.elementContexts,
    previewAnnotations: draft.previewAnnotations,
    reviewComments: draft.reviewComments,
  };
}

export function serializeThreadTurnPrompt(
  draft: ThreadTurnDraft,
  analysis: ThreadTurnDraftAnalysis,
): string {
  const withContexts = appendElementContextsToPrompt(
    appendTerminalContextsToPrompt(draft.prompt, analysis.sendableTerminalContexts),
    draft.elementContexts,
  );
  const withAnnotations = draft.previewAnnotations.reduce(
    (text, annotation) => appendPreviewAnnotationPrompt(text, annotation),
    withContexts,
  );
  return appendReviewCommentsToPrompt(withAnnotations, draft.reviewComments);
}

export function formatThreadTurnOutgoingPrompt(input: {
  readonly provider: ProviderDriverKind;
  readonly model: string | null;
  readonly models: ReadonlyArray<ServerProvider["models"][number]>;
  readonly effort: string | null;
  readonly text: string;
}): string {
  const capabilities = getProviderModelCapabilities(input.models, input.model, input.provider);
  return applyClaudePromptEffortPrefix(
    input.text,
    resolvePromptInjectedEffort(capabilities, input.effort),
  );
}

export function formatThreadTurnOutgoingText(draft: ThreadTurnDraft, text: string): string {
  return formatThreadTurnOutgoingPrompt({
    provider: draft.selectedProvider,
    model: draft.selectedModel,
    models: draft.selectedProviderModels,
    effort: draft.selectedPromptEffort,
    text,
  });
}

export function resolveNewThreadSubmissionTitle(
  draft: ThreadTurnDraft,
  analysis: ThreadTurnDraftAnalysis,
): string {
  const firstImage = draft.images[0];
  const firstTerminalContext = analysis.sendableTerminalContexts[0];
  const firstElementContext = draft.elementContexts[0];
  return truncate(
    analysis.trimmedPrompt ||
      (firstImage ? `Image: ${firstImage.name}` : "") ||
      (firstTerminalContext ? formatTerminalContextLabel(firstTerminalContext) : "") ||
      (firstElementContext ? formatElementContextLabel(firstElementContext) : "") ||
      "New thread",
  );
}

export function resolveFollowUpSubmissionTitle(
  analysis: ThreadTurnDraftAnalysis,
  currentTitle: string,
): string {
  return analysis.trimmedPrompt || currentTitle;
}

export function createDurableThreadTurnDeliveryAdapter(input: {
  readonly enqueue: (
    environmentId: EnvironmentId,
    command: DurableClientCommand,
  ) => Promise<unknown>;
}): ThreadTurnDeliveryAdapter {
  return {
    deliver: async (environmentId, command) => {
      await input.enqueue(environmentId, command);
    },
  };
}

export function createDirectThreadTurnDeliveryAdapter(input: {
  readonly dispatchCommand: (command: DurableClientCommand) => Promise<unknown>;
}): ThreadTurnDeliveryAdapter {
  return {
    deliver: async (_environmentId, command) => {
      await input.dispatchCommand(command);
    },
  };
}

function createOptimisticMessage(input: {
  readonly draft: ThreadTurnDraft;
  readonly messageId: MessageId;
  readonly text: string;
  readonly createdAt: string;
}): ChatMessage {
  const attachments = input.draft.images.map((image) => ({
    type: "image" as const,
    id: image.id,
    name: image.name,
    mimeType: image.mimeType,
    sizeBytes: image.sizeBytes,
    previewUrl: image.previewUrl,
  }));
  return {
    id: input.messageId,
    role: "user",
    text: input.text,
    ...(attachments.length > 0 ? { attachments } : {}),
    turnId: null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    streaming: false,
  };
}

function createCommand(input: {
  readonly attachments: ReadonlyArray<TurnAttachment>;
  readonly commandId: DurableClientCommand["commandId"];
  readonly createdAt: string;
  readonly messageId: MessageId;
  readonly outgoingText: string;
  readonly target: ThreadTurnSubmissionTarget;
  readonly title: string;
  readonly selectedModelSelection: ModelSelection;
  readonly selectedModel: string | null;
}): DurableClientCommand {
  const common = {
    commandId: input.commandId,
    threadId: input.target.threadId,
    message: {
      messageId: input.messageId,
      role: "user" as const,
      text: input.outgoingText,
      attachments: [...input.attachments],
    },
    modelSelection: input.selectedModelSelection,
    titleSeed: input.title,
    runtimeMode: input.target.runtimeMode,
    interactionMode: input.target.interactionMode,
    createdAt: input.createdAt,
  };
  if (input.target.queue) {
    return { type: "thread.message.queue", ...common };
  }
  const bootstrap =
    input.target.isLocalDraftThread || input.target.prepareWorkspace
      ? {
          ...(input.target.isLocalDraftThread
            ? {
                createThread: {
                  projectId: input.target.projectId,
                  title: input.title,
                  modelSelection: createModelSelection(
                    input.selectedModelSelection.instanceId,
                    input.selectedModel ||
                      input.target.projectDefaultModelSelection?.model ||
                      DEFAULT_MODEL,
                    input.selectedModelSelection.options,
                  ),
                  runtimeMode: input.target.runtimeMode,
                  interactionMode: input.target.interactionMode,
                  branch: input.target.activeBranch,
                  worktreePath: input.target.threadWorktreePath,
                  workspaceId: null,
                  createdAt: input.target.threadCreatedAt,
                },
              }
            : {}),
          ...(input.target.prepareWorkspace
            ? {
                prepareWorkspace: {
                  kind: "auto" as const,
                  roots: [
                    {
                      projectId: input.target.projectId,
                      sourcePath: input.target.projectWorkspaceRoot,
                      role: "primary" as const,
                      ...(input.target.baseRevision
                        ? { baseRevision: input.target.baseRevision }
                        : {}),
                      ...(input.target.startFromOrigin ? { startFromOrigin: true } : {}),
                    },
                  ],
                  displayNameSeed: input.title,
                  retentionPolicy: "explicit-delete" as const,
                },
                runSetupScript: true,
              }
            : {}),
        }
      : undefined;
  return {
    type: "thread.turn.start",
    ...common,
    ...(bootstrap ? { bootstrap } : {}),
  };
}

function composerHasContent(revision: ThreadComposerRevision): boolean {
  return (
    revision.prompt.length > 0 ||
    revision.imageIds.length > 0 ||
    revision.terminalContexts.length > 0 ||
    revision.elementContexts.length > 0 ||
    revision.previewAnnotations.length > 0 ||
    revision.reviewComments.length > 0
  );
}

export async function submitThreadTurn(
  input: SubmitThreadTurnInput,
): Promise<SubmitThreadTurnResult> {
  const analysis = input.analysis ?? analyzeThreadTurnDraft(input.draft);
  if (!analysis.hasSendableContent) {
    return { kind: "empty", analysis };
  }
  const createdAt = input.now();
  const messageId = input.makeMessageId();
  const serializedText = serializeThreadTurnPrompt(input.draft, analysis);
  const outgoingText =
    input.formatOutgoingText?.(input.draft, serializedText || IMAGE_ONLY_BOOTSTRAP_PROMPT) ??
    (serializedText || IMAGE_ONLY_BOOTSTRAP_PROMPT);
  const attachmentPromise = Promise.all(
    input.draft.images.map(async (image) => ({
      type: "image" as const,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      dataUrl: await (input.readAttachment ?? readFileAsDataUrl)(image.file),
    })),
  );
  const optimisticMessage = createOptimisticMessage({
    draft: input.draft,
    messageId,
    text: outgoingText,
    createdAt,
  });
  let attachments: ReadonlyArray<TurnAttachment> = [];
  let failure: unknown = null;
  let command: DurableClientCommand | null = null;

  const composerRevision = threadComposerRevision({
    ...input.draft,
    terminalContexts: analysis.sendableTerminalContexts,
  });
  const provisionalCommand = createCommand({
    attachments: [],
    commandId: input.makeCommandId(),
    createdAt,
    messageId,
    outgoingText,
    target: input.target,
    title: input.title,
    selectedModelSelection: input.draft.selectedModelSelection,
    selectedModel: input.draft.selectedModel,
  });
  let prepared: PreparedThreadTurnSubmission = {
    analysis,
    command: provisionalCommand,
    composerRevision,
    draft: { ...input.draft, terminalContexts: analysis.sendableTerminalContexts },
    messageId,
    optimisticMessage,
    preparingWorkspace: input.target.prepareWorkspace,
    queue: input.target.queue,
    title: input.title,
  };

  try {
    await input.lifecycle?.beforeTransaction?.(prepared);
    input.lifecycle?.begin?.({ preparingWorkspace: input.target.prepareWorkspace });
    input.lifecycle?.prepared?.(prepared);
    input.lifecycle?.addOptimistic?.(optimisticMessage, "prepared");
    if (analysis.expiredTerminalContextCount > 0) {
      input.lifecycle?.expiredContextsOmitted?.(analysis.expiredTerminalContextCount);
    }

    try {
      if (input.target.isFirstMessage && input.target.isServerThread) {
        await input.lifecycle?.updateTitle?.(input.title);
      }
      if (input.target.isServerThread) {
        await input.lifecycle?.persistSettings?.({
          threadId: input.target.threadId,
          createdAt,
          ...(input.draft.selectedModel
            ? { modelSelection: input.draft.selectedModelSelection }
            : {}),
          runtimeMode: input.target.runtimeMode,
          interactionMode: input.target.interactionMode,
        });
      }
    } catch (error) {
      failure = error;
    }

    try {
      attachments = await attachmentPromise;
    } catch (error) {
      failure ??= error;
    }

    if (failure === null) {
      command = createCommand({
        attachments,
        commandId: provisionalCommand.commandId,
        createdAt,
        messageId,
        outgoingText,
        target: input.target,
        title: input.title,
        selectedModelSelection: input.draft.selectedModelSelection,
        selectedModel: input.draft.selectedModel,
      });
      prepared = { ...prepared, command };
      if (!input.target.queue) input.lifecycle?.beforeStartDelivery?.();
      try {
        await input.delivery.deliver(input.target.environmentId, command);
      } catch (error) {
        failure = error;
      }
    }

    if (failure !== null) {
      if (!composerHasContent(input.composer.readCurrentRevision()) && input.composer.restore) {
        input.lifecycle?.removeOptimistic?.(messageId);
        input.composer.restore({
          ...prepared.draft,
          images: prepared.draft.images.map(cloneComposerImageForRetry),
        });
      }
      input.lifecycle?.failed?.(failure, prepared);
      input.lifecycle?.settled?.(false, prepared);
      return { kind: "failed", error: failure, prepared };
    }

    input.lifecycle?.delivered?.(prepared);
    if (!input.target.queue) {
      input.lifecycle?.addOptimistic?.(optimisticMessage, "start-delivered");
    }
    if (
      input.composer.clearOnSuccess === "always" ||
      shouldClearComposerAfterDurableEnqueue(
        prepared.composerRevision,
        input.composer.readCurrentRevision(),
      )
    ) {
      input.composer.clear();
    }
    input.lifecycle?.settled?.(true, prepared);
    return { kind: "delivered", prepared };
  } catch (error) {
    // Lifecycle setup can fail before the normal delivery path. Settle through
    // the same failure interface so callers never leave local busy state stuck.
    input.lifecycle?.failed?.(error, prepared);
    input.lifecycle?.settled?.(false, prepared);
    return { kind: "failed", error, prepared };
  }
}
