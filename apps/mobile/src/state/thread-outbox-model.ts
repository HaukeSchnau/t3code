import { isTransportConnectionErrorMessage } from "@t3tools/client-runtime/errors";
import {
  makeDurableCommandDeliveryPlan,
  type DurableCommandDeliveryPlan,
} from "@t3tools/client-runtime/operations/command-outbox";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
import {
  CommandId,
  EnvironmentId,
  IsoDateTime,
  MessageId,
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  SkillPackId,
  ThreadId,
  type ModelSelection as ModelSelectionType,
  type ProjectId as ProjectIdType,
  type ProviderInteractionMode as ProviderInteractionModeType,
  type RuntimeMode as RuntimeModeType,
  type SkillPackId as SkillPackIdType,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { UploadedMobileAttachment } from "../lib/attachmentUpload";
import { DraftComposerAttachmentSchema } from "../lib/composer-image-schema";
import { toUploadChatImageAttachments, type DraftComposerAttachment } from "../lib/composerImages";
import { buildProjectThreadStartTurnInput } from "../lib/projectThreadStartTurn";
import { scopedThreadKey } from "../lib/scopedEntities";
import { resolveProviderInteractionMode } from "../features/threads/legacy-plan-mode";

// Keep current writes until a compatible native baseline includes the v4 reader.
const THREAD_OUTBOX_SCHEMA_VERSION = 3;
const THREAD_OUTBOX_MAX_RETRY_DELAY_MS = 16_000;

const QueuedThreadCreationSchema = Schema.Struct({
  projectId: ProjectId,
  // Snapshot of the project's display metadata so a pending task stays
  // presentable in the thread list even when the project shell is not loaded.
  projectTitle: Schema.optional(Schema.String),
  projectCwd: Schema.optional(Schema.String),
  workspaceMode: Schema.Literals(["local", "worktree"]),
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  startFromOrigin: Schema.optional(Schema.Boolean),
  skillPackIds: Schema.optional(Schema.Array(SkillPackId)),
});

export const QueuedThreadMessageSchema = Schema.Struct({
  schemaVersion: Schema.Literals([1, 2, THREAD_OUTBOX_SCHEMA_VERSION, 4]),
  environmentId: EnvironmentId,
  threadId: ThreadId,
  messageId: MessageId,
  commandId: CommandId,
  text: Schema.String,
  attachments: Schema.Array(DraftComposerAttachmentSchema),
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  // Present when the queued item creates a brand-new thread (pending task)
  // instead of appending a turn to an existing one.
  creation: Schema.optional(QueuedThreadCreationSchema),
  // Frozen when queued so ambiguous retries replay byte-for-byte equivalent
  // bootstrap intent rather than generating a new worktree branch.
  deliveryWorktreeBranchName: Schema.optional(Schema.String),
  replacesCommandId: Schema.optional(CommandId),
  supersedesCommandIds: Schema.optional(Schema.Array(CommandId)),
  acknowledgedAt: Schema.optional(IsoDateTime),
  discardedAt: Schema.optional(IsoDateTime),
  createdAt: IsoDateTime,
});

const decodeStoredQueuedThreadMessage = Schema.decodeUnknownSync(QueuedThreadMessageSchema);
const encodeStoredQueuedThreadMessage = Schema.encodeUnknownSync(QueuedThreadMessageSchema);

export interface QueuedThreadCreation {
  readonly projectId: ProjectIdType;
  readonly projectTitle?: string;
  readonly projectCwd?: string;
  readonly workspaceMode: "local" | "worktree";
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly startFromOrigin?: boolean;
  readonly skillPackIds?: ReadonlyArray<SkillPackIdType>;
}

export interface QueuedThreadMessage {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly commandId: CommandId;
  readonly text: string;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly modelSelection?: ModelSelectionType;
  readonly runtimeMode?: RuntimeModeType;
  readonly interactionMode?: ProviderInteractionModeType;
  readonly creation?: QueuedThreadCreation;
  readonly deliveryWorktreeBranchName?: string;
  readonly replacesCommandId?: CommandId;
  readonly supersedesCommandIds?: ReadonlyArray<CommandId>;
  readonly acknowledgedAt?: string;
  readonly discardedAt?: string;
  readonly createdAt: string;
}

export function makeQueuedThreadDeliveryPlan(
  message: QueuedThreadMessage,
): DurableCommandDeliveryPlan {
  const attachments = queuedMessageWireAttachments(message.attachments);
  const settings = {
    modelSelection: message.modelSelection,
    runtimeMode: message.runtimeMode ?? "full-access",
    interactionMode: message.interactionMode ?? "default",
  } as const;
  const command = message.creation
    ? {
        type: "thread.turn.start" as const,
        ...buildProjectThreadStartTurnInput({
          projectId: message.creation.projectId,
          projectCwd: message.creation.projectCwd ?? "",
          threadId: message.threadId,
          commandId: message.commandId,
          messageId: message.messageId,
          createdAt: message.createdAt,
          text: message.text.trim(),
          uploadedAttachments: attachments,
          modelSelection: message.modelSelection!,
          runtimeMode: settings.runtimeMode,
          interactionMode: settings.interactionMode,
          workspaceMode: message.creation.workspaceMode,
          branch: message.creation.branch,
          worktreePath: message.creation.worktreePath,
          startFromOrigin: message.creation.startFromOrigin ?? false,
          ...(message.creation.skillPackIds ? { skillPackIds: message.creation.skillPackIds } : {}),
          worktreeBranchName: message.deliveryWorktreeBranchName ?? `t3-code/${message.commandId}`,
        }),
      }
    : {
        type: "thread.turn.start" as const,
        commandId: message.commandId,
        threadId: message.threadId,
        message: {
          messageId: message.messageId,
          role: "user" as const,
          text: message.text,
          attachments,
        },
        ...settings,
        createdAt: message.createdAt,
      };
  return makeDurableCommandDeliveryPlan({
    environmentId: message.environmentId,
    enqueuedAt: message.createdAt,
    command,
  });
}

function queuedMessageWireAttachments(
  attachments: ReadonlyArray<DraftComposerAttachment>,
): ReadonlyArray<UploadedMobileAttachment> {
  const wireAttachments: Array<UploadedMobileAttachment> = [];
  for (const attachment of attachments) {
    if (attachment.type === "image") {
      wireAttachments.push(...toUploadChatImageAttachments([attachment]));
      continue;
    }
    if (attachment.uploadedAttachmentId === undefined) {
      continue;
    }
    wireAttachments.push({
      type: "file",
      id: attachment.uploadedAttachmentId,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
    });
  }
  return wireAttachments;
}

export interface ThreadSettingsSnapshot {
  readonly modelSelection: ModelSelectionType;
  readonly runtimeMode: RuntimeModeType;
  readonly interactionMode: ProviderInteractionModeType;
}

export function resolveQueuedThreadSettings(
  message: QueuedThreadMessage,
  thread: ThreadSettingsSnapshot,
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "showInteractionModeToggle">> = [],
): ThreadSettingsSnapshot {
  const modelSelection = message.modelSelection ?? thread.modelSelection;
  const provider = providers.find(
    (candidate) => candidate.instanceId === modelSelection.instanceId,
  );
  return {
    modelSelection,
    runtimeMode: message.runtimeMode ?? thread.runtimeMode,
    interactionMode: resolveProviderInteractionMode(
      provider,
      message.interactionMode ?? thread.interactionMode,
    ),
  };
}

export function modelSelectionsEqual(left: ModelSelectionType, right: ModelSelectionType): boolean {
  return (
    left.instanceId === right.instanceId &&
    left.model === right.model &&
    JSON.stringify(left.options ?? null) === JSON.stringify(right.options ?? null)
  );
}

export function encodeQueuedThreadMessage(message: QueuedThreadMessage): unknown {
  return encodeStoredQueuedThreadMessage({
    schemaVersion: THREAD_OUTBOX_SCHEMA_VERSION,
    ...message,
  });
}

export function decodeQueuedThreadMessage(value: unknown): QueuedThreadMessage {
  const { schemaVersion: _, ...message } = decodeStoredQueuedThreadMessage(value);
  return message;
}

export function groupQueuedThreadMessages(
  messages: ReadonlyArray<QueuedThreadMessage>,
): Record<string, ReadonlyArray<QueuedThreadMessage>> {
  const deduplicated = new Map<MessageId, QueuedThreadMessage>();
  for (const message of messages) {
    deduplicated.set(message.messageId, message);
  }

  const grouped: Record<string, Array<QueuedThreadMessage>> = {};
  for (const message of deduplicated.values()) {
    const threadKey = scopedThreadKey(message.environmentId, message.threadId);
    (grouped[threadKey] ??= []).push(message);
  }
  for (const queue of Object.values(grouped)) {
    queue.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
  return grouped;
}

export function flattenQueuedThreadMessages(
  queues: Record<string, ReadonlyArray<QueuedThreadMessage>>,
): ReadonlyArray<QueuedThreadMessage> {
  return Object.values(queues).flat();
}

export function threadOutboxRetryDelayMs(attempt: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attempt - 1), THREAD_OUTBOX_MAX_RETRY_DELAY_MS);
}

export type ThreadOutboxDeliveryAction = "wait" | "remove" | "send";

export function resolveThreadOutboxDeliveryAction(input: {
  readonly isCreation: boolean;
  readonly threadExists: boolean;
  readonly shellStatus: EnvironmentShellStatus;
  readonly environmentConnected: boolean;
  readonly threadBusy: boolean;
}): ThreadOutboxDeliveryAction {
  if (input.isCreation) {
    // A pending task creates its thread on delivery. If the thread already
    // exists the creation command went through and only cleanup remains.
    if (input.threadExists) {
      return "remove";
    }
    // Wait for the shell to be live before sending: until the thread list has
    // synchronized, a previously delivered creation whose cleanup failed would
    // look missing and get re-issued, duplicating the thread.
    return input.environmentConnected && input.shellStatus === "live" ? "send" : "wait";
  }
  if (!input.threadExists) {
    return input.shellStatus === "live" ? "remove" : "wait";
  }
  return input.environmentConnected ? "send" : "wait";
}

/**
 * A queued creation can only be dispatched once its payload would pass server
 * validation; incomplete payloads stay pending until the user edits them.
 */
export function isQueuedThreadCreationSendable(message: QueuedThreadMessage): boolean {
  if (!message.creation) {
    return false;
  }
  if (message.text.trim().length === 0 || message.modelSelection === undefined) {
    return false;
  }
  return message.creation.workspaceMode !== "worktree" || Boolean(message.creation.branch);
}

function errorMessage(error: unknown): string | null {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    return typeof error.message === "string" ? error.message : null;
  }
  return typeof error === "string" ? error : null;
}

export function shouldRetryThreadOutboxDelivery(error: unknown): boolean {
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "ConnectionTransientError"
  ) {
    return true;
  }
  return isTransportConnectionErrorMessage(errorMessage(error));
}

export type ThreadOutboxCommandStage = "settings-sync" | "start-turn";
export type ThreadOutboxFailureAction = "retry" | "discard";

export function resolveThreadOutboxFailureAction(input: {
  readonly stage: ThreadOutboxCommandStage;
  readonly error: unknown;
  readonly interrupted: boolean;
}): ThreadOutboxFailureAction {
  if (
    input.stage === "settings-sync" ||
    input.interrupted ||
    shouldRetryThreadOutboxDelivery(input.error)
  ) {
    return "retry";
  }
  return "discard";
}
