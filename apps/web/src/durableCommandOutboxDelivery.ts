import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { StartThreadTurnInput } from "@t3tools/client-runtime/operations";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  deletePendingAttachmentUpload,
  runAttachmentUploadCycle,
} from "@t3tools/client-runtime/state/attachments";
import {
  classifyCommandDeliveryFailure,
  CommandOutboxDeliveryError,
} from "@t3tools/client-runtime/state/command-outbox";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  type ChatAttachment,
  type ChatFileAttachment,
  type ChatImageAttachment,
  type EnvironmentId,
  type UploadChatAttachment,
} from "@t3tools/contracts";
import { remapComposerContextAttachments } from "@t3tools/shared/composerContextReferences";
import { serializeLegacyContextMessage } from "@t3tools/shared/composerContextLegacySend";

import { readFileAsDataUrl } from "./components/ChatView.logic";
import { fileAttachmentCapabilityBlockReason } from "./components/chat/composerAttachmentFiles";
import type { DurableComposerCommand, DurableComposerEntry } from "./durableCommandOutbox";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { attachmentEnvironment } from "./state/attachments";
import { readThreadShell } from "./state/entities";
import { environmentServerConfigsAtom } from "./state/server";
import { readPreparedConnection } from "./state/session";
import { threadEnvironment } from "./state/threads";

const UPLOAD_TIMEOUT_MS = 5 * 60_000;

/** Uploads happen before the command is sent, so their failures never make it ambiguous. */
function uploadFailure(error: unknown): CommandOutboxDeliveryError {
  const failure = classifyCommandDeliveryFailure(error);
  return new CommandOutboxDeliveryError({
    classification: failure.classification === "permanent" ? "permanent" : "transient",
    message: failure.message,
  });
}

class UploadRejectedError extends Error {
  constructor(readonly status: number) {
    super(`The environment refused the upload (${status}).`);
  }
}

function postBlob(url: string, blob: Blob, mimeType: string) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  const done = fetch(url, {
    method: "POST",
    headers: { "Content-Type": mimeType },
    body: blob,
    signal: controller.signal,
  })
    .then((response) => {
      if (!response.ok) throw new UploadRejectedError(response.status);
    })
    .finally(() => window.clearTimeout(timeout));
  return { done, abort: () => controller.abort() };
}

async function uploadAttachment(
  environmentId: EnvironmentId,
  attachment: ChatImageAttachment | ChatFileAttachment,
  blob: Blob,
): Promise<string> {
  const mimeType = attachment.mimeType.toLowerCase();
  const result = await runAttachmentUploadCycle({
    registry: appAtomRegistry,
    createUploadUrl: attachmentEnvironment.createUploadUrl,
    remove: attachmentEnvironment.remove,
    environmentId,
    upload: {
      ...(attachment.type === "file" ? { type: "file" as const } : {}),
      name: attachment.name,
      mimeType,
      sizeBytes: blob.size,
    },
    resolveUploadUrl: (relativeUrl) => {
      const connection = readPreparedConnection(environmentId);
      return connection ? resolveAssetUrl(connection.httpBaseUrl, relativeUrl) : null;
    },
    transport: (url) => postBlob(url, blob, mimeType),
  });
  if (result.status === "uploaded") return result.attachmentId;
  if (result.attachmentId !== null) {
    deletePendingAttachmentUpload({
      registry: appAtomRegistry,
      remove: attachmentEnvironment.remove,
      environmentId,
      attachmentId: result.attachmentId,
    });
  }
  if (result.status === "failed" && result.error instanceof UploadRejectedError) {
    const status = result.error.status;
    const retryable = status === 408 || status === 429 || status >= 500;
    throw new CommandOutboxDeliveryError({
      classification: retryable ? "transient" : "permanent",
      message: `'${attachment.name}' could not upload: ${result.error.message}`,
    });
  }
  throw uploadFailure(result.status === "failed" ? result.error : "Upload cancelled");
}

function throwOnFailure(result: AtomCommandResult<unknown, unknown>): void {
  if (result._tag === "Success") return;
  if (isAtomCommandInterrupted(result)) {
    throw new CommandOutboxDeliveryError({
      classification: "ambiguous",
      message: "Sending was interrupted before the environment replied.",
    });
  }
  throw squashAtomCommandFailure(result);
}

/** Brings an existing thread's modes in line with the message, idempotently per command. */
async function syncThreadSettings(command: DurableComposerCommand): Promise<void> {
  if (command.bootstrap?.createThread) return;
  const thread = readThreadShell(scopeThreadRef(command.environmentId, command.threadId));
  if (thread === null) return;
  if (thread.runtimeMode !== command.runtimeMode) {
    throwOnFailure(
      await runAtomCommand(
        appAtomRegistry,
        threadEnvironment.setRuntimeMode,
        {
          environmentId: command.environmentId,
          input: {
            commandId: CommandId.make(`${command.commandId}:runtime-mode`),
            threadId: command.threadId,
            runtimeMode: command.runtimeMode,
            createdAt: command.createdAt,
          },
        },
        { reportFailure: false },
      ),
    );
  }
  if (thread.interactionMode !== command.interactionMode) {
    throwOnFailure(
      await runAtomCommand(
        appAtomRegistry,
        threadEnvironment.setInteractionMode,
        {
          environmentId: command.environmentId,
          input: {
            commandId: CommandId.make(`${command.commandId}:interaction-mode`),
            threadId: command.threadId,
            interactionMode: command.interactionMode,
            createdAt: command.createdAt,
          },
        },
        { reportFailure: false },
      ),
    );
  }
}

/** Uploads, settings, then the turn itself, all keyed to the frozen command id. */
export async function deliverDurableComposerCommand(
  entry: DurableComposerEntry,
  record: (command: DurableComposerCommand) => Promise<void>,
): Promise<void> {
  const { command } = entry;
  const config = appAtomRegistry.get(environmentServerConfigsAtom).get(command.environmentId);
  if (config === undefined) {
    throw new CommandOutboxDeliveryError({
      classification: "transient",
      message: "Waiting for the environment's settings.",
    });
  }
  const { capabilities } = config.environment;
  const supportsUploads = capabilities.attachmentUploads === true;
  const fileBlockReason = fileAttachmentCapabilityBlockReason({
    files: command.attachments.flatMap(({ attachment }) =>
      attachment.type === "file" ? [attachment] : [],
    ),
    attachmentUploadsCapabilityKnown: true,
    supportsAttachmentUploads: supportsUploads,
    maxFileAttachmentBytes: capabilities.fileAttachments?.maxUploadBytes ?? null,
  });
  if (fileBlockReason !== null) {
    throw new CommandOutboxDeliveryError({ classification: "permanent", message: fileBlockReason });
  }

  const attachments = [...command.attachments];
  const wireAttachments: Array<ChatAttachment | UploadChatAttachment> = [];
  const wireIds: Array<{ readonly id: string }> = [];
  for (const [index, stored] of attachments.entries()) {
    const { attachment, blob } = stored;
    if (stored.uploadedAttachmentId !== undefined) {
      wireAttachments.push({ ...attachment, id: stored.uploadedAttachmentId });
      wireIds.push({ id: stored.uploadedAttachmentId });
      continue;
    }
    if (blob === null) {
      throw new CommandOutboxDeliveryError({
        classification: "permanent",
        message: `'${attachment.name}' is no longer on this device. Attach it again.`,
      });
    }
    if (supportsUploads) {
      const uploadedAttachmentId = await uploadAttachment(command.environmentId, attachment, blob);
      attachments[index] = { ...stored, uploadedAttachmentId };
      await record({ ...command, attachments: [...attachments] });
      wireAttachments.push({ ...attachment, id: uploadedAttachmentId });
      wireIds.push({ id: uploadedAttachmentId });
      continue;
    }
    if (attachment.type !== "image") {
      throw new CommandOutboxDeliveryError({
        classification: "permanent",
        message: "This server does not support file attachments.",
      });
    }
    wireAttachments.push({
      ...attachment,
      dataUrl: await readFileAsDataUrl(
        new File([blob], attachment.name, { type: attachment.mimeType }),
      ),
    });
    wireIds.push({ id: attachment.id });
  }

  await syncThreadSettings(command);

  const context = remapComposerContextAttachments(
    command.context,
    command.attachments.map(({ attachment }) => attachment),
    wireIds,
  );
  const inlineContext = capabilities.inlineMessageContext === true;
  const input: StartThreadTurnInput = {
    commandId: command.commandId,
    threadId: command.threadId,
    createdAt: command.createdAt,
    message: {
      messageId: command.messageId,
      role: "user",
      text:
        context && !inlineContext
          ? serializeLegacyContextMessage({ text: command.text, records: context.records })
          : command.text,
      attachments: wireAttachments,
      ...(context && inlineContext ? { context } : {}),
    },
    modelSelection: command.modelSelection,
    titleSeed: command.titleSeed,
    runtimeMode: command.runtimeMode,
    interactionMode: command.interactionMode,
    dispatchMode: command.dispatchMode,
    ...(command.bootstrap ? { bootstrap: command.bootstrap } : {}),
  };
  throwOnFailure(
    await runAtomCommand(
      appAtomRegistry,
      threadEnvironment.startTurn,
      { environmentId: command.environmentId, input },
      { reportFailure: false },
    ),
  );
}
