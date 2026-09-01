import { type MessageId } from "@t3tools/contracts";
import { randomHex } from "~/lib/utils";
import { type ComposerImageAttachment } from "../../composerDraftStore";
import { isImageAttachment, type ChatMessage, type Thread } from "../../types";
import { revokeBlobPreviewUrl } from "../ChatView.logic";

export function editableTextFromUserMessage(text: string): string {
  const trimmed = text.trim();
  return trimmed.startsWith("Ultrathink:\n") ? trimmed.slice("Ultrathink:\n".length) : trimmed;
}

export type PreviousMessageEditTransactionResult =
  | { readonly kind: "delivered" }
  | {
      readonly kind: "failed";
      readonly stage: "prune" | "replacement";
      readonly error: unknown;
    };

export async function runPreviousMessageEditTransaction(input: {
  readonly pruneHistory: () => Promise<void>;
  readonly waitForPrunedHistory: () => Promise<void>;
  readonly submitReplacement: () => Promise<void>;
  readonly onHistoryPruned: () => void;
  readonly onReplacementFailed: () => void;
}): Promise<PreviousMessageEditTransactionResult> {
  try {
    await input.pruneHistory();
    await input.waitForPrunedHistory();
  } catch (error) {
    return { kind: "failed", stage: "prune", error };
  }

  input.onHistoryPruned();
  try {
    await input.submitReplacement();
    return { kind: "delivered" };
  } catch (error) {
    input.onReplacementFailed();
    return { kind: "failed", stage: "replacement", error };
  }
}

export async function hydrateMessageImagesForEdit(
  message: ChatMessage,
): Promise<ComposerImageAttachment[]> {
  const attachments = message.attachments ?? [];
  const images: ComposerImageAttachment[] = [];
  try {
    for (const [index, attachment] of attachments.entries()) {
      if (!isImageAttachment(attachment)) {
        continue;
      }
      if (!attachment.previewUrl) {
        throw new Error(`Image attachment '${attachment.name}' is missing a preview URL.`);
      }
      const response = await fetch(attachment.previewUrl, { credentials: "include" });
      if (!response.ok) {
        throw new Error(`Failed to load image attachment '${attachment.name}'.`);
      }
      const blob = await response.blob();
      const mimeType = blob.type || attachment.mimeType;
      const file = new File([blob], attachment.name, { type: mimeType });
      images.push({
        type: "image",
        id: `edit-${index}-${randomHex(8)}`,
        name: attachment.name,
        mimeType,
        sizeBytes: blob.size || attachment.sizeBytes,
        previewUrl: URL.createObjectURL(file),
        file,
      });
    }
  } catch (error) {
    for (const image of images) {
      revokeBlobPreviewUrl(image.previewUrl);
    }
    throw error;
  }
  return images;
}

export async function waitForMessagePrunedFromThread(input: {
  messageId: MessageId;
  readThread: () => Thread | undefined;
  timeoutMs?: number;
}): Promise<void> {
  const deadline = Date.now() + (input.timeoutMs ?? 15_000);
  while (Date.now() < deadline) {
    const currentThread = input.readThread();
    if (
      currentThread &&
      !currentThread.messages.some((message) => message.id === input.messageId)
    ) {
      return;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for the thread history to update.");
}
