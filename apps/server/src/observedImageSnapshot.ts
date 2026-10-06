// @effect-diagnostics nodeBuiltinImport:off -- snapshots follow attachmentStore's path and id helpers.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import {
  ChatAttachmentId,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ChatImageAttachment,
  type ThreadId,
} from "@t3tools/contracts";
import {
  isWorkspaceImagePreviewPath,
  mediaMimeTypeFromExtension,
} from "@t3tools/shared/filePreview";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

import { createDeterministicAttachmentId, resolveAttachmentPath } from "./attachmentStore.ts";
import { projectHostPath } from "./project/SeparateProjectRegistry.ts";

/**
 * Copies an image an agent viewed into its thread's attachments, so the preview
 * survives later edits or deletion of the original. The id hashes the bytes, so
 * repeated views of one image share a copy. Thread deletion removes it with the
 * thread's other attachments. Best effort: a failure leaves the item without a
 * snapshot and never fails event ingestion.
 */
export const snapshotObservedImage = (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly attachmentsDir: string;
  readonly threadId: ThreadId;
  /** The path as the agent reported it. */
  readonly path: string;
  /** The thread's host cwd. Paths from agents in separate projects map through it. */
  readonly cwd: string | null;
  readonly agentExecState: string | undefined;
}): Effect.Effect<ChatImageAttachment | undefined> =>
  Effect.gen(function* () {
    const mimeType = isWorkspaceImagePreviewPath(input.path)
      ? mediaMimeTypeFromExtension(NodePath.extname(input.path))
      : null;
    if (mimeType === null || !mimeType.startsWith("image/")) return undefined;
    const { cwd } = input;
    const hostPath =
      cwd === null
        ? input.path
        : yield* Effect.tryPromise(() =>
            projectHostPath(cwd, NodePath.resolve(cwd, input.path), input.agentExecState),
          );
    const info = yield* input.fileSystem.stat(hostPath);
    if (
      info.type !== "File" ||
      info.size === 0n ||
      info.size > BigInt(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)
    ) {
      return undefined;
    }
    const bytes = yield* input.fileSystem.readFile(hostPath);
    if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
      return undefined;
    }
    const contentHash = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
    const id = createDeterministicAttachmentId(input.threadId, `observed-image:${contentHash}`);
    if (id === null) return undefined;
    const attachment: ChatImageAttachment = {
      type: "image",
      id: ChatAttachmentId.make(id),
      name: NodePath.basename(input.path).trim().slice(0, 255) || "image",
      mimeType,
      sizeBytes: bytes.byteLength,
    };
    const target = resolveAttachmentPath({ attachmentsDir: input.attachmentsDir, attachment });
    if (target === null) return undefined;
    if (!(yield* input.fileSystem.exists(target))) {
      // Readers never see a partial file. A crash leaves a ".part" file that the
      // pending-attachment sweep removes.
      const partial = `${target}.${NodeCrypto.randomUUID()}.part`;
      yield* input.fileSystem.makeDirectory(input.attachmentsDir, { recursive: true });
      yield* input.fileSystem.writeFile(partial, bytes);
      yield* input.fileSystem.rename(partial, target);
    }
    return attachment;
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Failed to snapshot an observed image.", {
        path: input.path,
        cause,
      }).pipe(Effect.as(undefined)),
    ),
    Effect.withSpan("snapshotObservedImage"),
  );
