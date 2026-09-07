import * as FileSystem from "effect/FileSystem";
import { ChatAttachmentId, type ChatAttachment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  attachmentFileExtension,
  createDeterministicAttachmentId,
  parseAttachmentFileExtension,
  parseAttachmentUuid,
  parseThreadSegmentFromAttachmentId,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  planAttachmentClaim,
  resolveAttachmentPath,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { inferImageExtension } from "../imageMime.ts";

export class AttachmentClaimError extends Schema.TaggedErrorClass<AttachmentClaimError>()(
  "AttachmentClaimError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface ClaimedAttachments {
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly claimedPaths: ReadonlyArray<string>;
}

export function attachmentIsPendingUpload(attachment: ChatAttachment): boolean {
  return parseThreadSegmentFromAttachmentId(attachment.id) === PENDING_ATTACHMENT_THREAD_SEGMENT;
}

export type PendingAttachmentNormalizationResult =
  | {
      readonly ok: true;
      readonly attachments: ReadonlyArray<ChatAttachment>;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Rewrites pending upload refs to their deterministic native refs without
 * touching the attachment store. This is used to reconstruct the canonical
 * command envelope before checking a receipt, including after the pending
 * source and its delivered copy have both been removed.
 */
export function normalizePendingAttachmentReferences(input: {
  readonly threadId: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}): PendingAttachmentNormalizationResult {
  if (!input.attachments.some(attachmentIsPendingUpload)) {
    return { ok: true, attachments: input.attachments };
  }
  if (!toSafeThreadAttachmentSegment(input.threadId)) {
    return { ok: false, reason: "invalid thread id" };
  }

  const attachments: ChatAttachment[] = [];
  for (const attachment of input.attachments) {
    if (!attachmentIsPendingUpload(attachment)) {
      attachments.push(attachment);
      continue;
    }

    const uuid = parseAttachmentUuid(attachment.id);
    const pendingSegment = parseThreadSegmentFromAttachmentId(attachment.id);
    if (!uuid || pendingSegment !== PENDING_ATTACHMENT_THREAD_SEGMENT) {
      return { ok: false, reason: "invalid attachment id" };
    }

    const normalizedMimeType = attachment.mimeType.toLowerCase();
    const expectedExtension =
      attachment.type === "image"
        ? inferImageExtension({ mimeType: normalizedMimeType, fileName: attachment.name })
        : attachment.type === "file"
          ? attachmentFileExtension(attachment.name)
          : null;
    if (!expectedExtension) {
      return { ok: false, reason: "attachment type is not supported for uploads" };
    }

    const declaredExtension = parseAttachmentFileExtension(attachment.id);
    if (declaredExtension && declaredExtension !== expectedExtension.slice(1)) {
      return { ok: false, reason: "attachment type does not match the upload" };
    }

    const finalId = createDeterministicAttachmentId(
      input.threadId,
      attachment.id,
      declaredExtension === null ? undefined : `.${declaredExtension}`,
    );
    if (!finalId) {
      return { ok: false, reason: "failed to create attachment id" };
    }
    attachments.push({
      ...attachment,
      id: ChatAttachmentId.make(finalId),
      mimeType: normalizedMimeType,
    });
  }

  return { ok: true, attachments };
}

/** Best-effort removal of claimed copies after a failed dispatch: the pending
 *  upload remains the retry source, so only the thread-scoped copies go. */
export const releaseClaimedAttachments = Effect.fn("AttachmentClaims.releaseClaimedAttachments")(
  function* (claimedPaths: ReadonlyArray<string>) {
    if (claimedPaths.length === 0) return;
    const fileSystem = yield* FileSystem.FileSystem;
    yield* Effect.forEach(claimedPaths, (path) => fileSystem.remove(path).pipe(Effect.ignore), {
      concurrency: 1,
      discard: true,
    });
  },
);

/**
 * Claims pending uploads into the target thread's attachment store before the
 * command enters the orchestrator: verifies the staged file, copies it under a
 * thread-scoped id, and rewrites the attachment ref. A copy, not a move — the
 * pending file stays behind as the retry source for a failed bootstrap, and
 * the periodic pending sweep reclaims it later. Already-claimed attachments
 * pass through untouched.
 */
export const claimPendingAttachments = Effect.fn("AttachmentClaims.claimPendingAttachments")(
  function* (input: {
    readonly threadId: string;
    readonly attachments: ReadonlyArray<ChatAttachment>;
  }) {
    if (!input.attachments.some(attachmentIsPendingUpload)) {
      return { attachments: input.attachments, claimedPaths: [] } satisfies ClaimedAttachments;
    }
    const serverConfig = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const claimedPaths: string[] = [];
    const attachments = yield* Effect.forEach(
      input.attachments,
      (attachment) =>
        Effect.gen(function* () {
          if (!attachmentIsPendingUpload(attachment)) {
            return attachment;
          }
          const claim = planAttachmentClaim({
            attachmentsDir: serverConfig.attachmentsDir,
            threadId: input.threadId,
            attachmentId: attachment.id,
          });
          if (!claim.ok) {
            return yield* new AttachmentClaimError({
              message: `Attachment '${attachment.name}' cannot be sent: ${claim.reason}.`,
            });
          }
          const normalized: ChatAttachment = {
            ...attachment,
            id: ChatAttachmentId.make(claim.finalId),
            mimeType: attachment.mimeType.toLowerCase(),
          };
          const expectedPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment: normalized,
          });
          if (expectedPath !== claim.finalPath) {
            return yield* new AttachmentClaimError({
              message: `Attachment '${attachment.name}' cannot be sent: attachment type does not match the upload.`,
            });
          }
          // A receipt can be accepted before the client retries. Keep the
          // delivered file authoritative when the pending source was swept,
          // and never overwrite a delivered file that may have been edited.
          if (claim.currentPath === null || (yield* fileSystem.exists(claim.finalPath))) {
            return normalized;
          }
          const info = yield* fileSystem.stat(claim.currentPath).pipe(
            Effect.mapError(
              (cause) =>
                new AttachmentClaimError({
                  message: `Attachment '${attachment.name}' cannot be sent: attachment not found.`,
                  cause,
                }),
            ),
          );
          if (Number(info.size) !== attachment.sizeBytes) {
            return yield* new AttachmentClaimError({
              message: `Attachment '${attachment.name}' cannot be sent: stored size does not match.`,
            });
          }
          // A copy, not a hard link: an agent editing the delivered file in
          // place must not mutate the retry source.
          yield* fileSystem.copy(claim.currentPath, claim.finalPath, { overwrite: false }).pipe(
            Effect.mapError(
              (cause) =>
                new AttachmentClaimError({
                  message: `Failed to claim attachment '${attachment.name}' for this thread.`,
                  cause,
                }),
            ),
          );
          claimedPaths.push(claim.finalPath);
          return normalized;
        }),
      { concurrency: 1 },
    ).pipe(Effect.tapError(() => releaseClaimedAttachments(claimedPaths)));
    return { attachments, claimedPaths } satisfies ClaimedAttachments;
  },
);
