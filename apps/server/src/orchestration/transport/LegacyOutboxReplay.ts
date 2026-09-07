// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  OrchestrationDispatchCommandError,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ChatAttachment,
  type LegacyOutboxCommand,
  OrchestrationCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { commandEnvelopeFingerprint } from "../CommandEnvelope.ts";

import {
  createDeterministicAttachmentId,
  resolveAttachmentPath,
  planAttachmentClaim,
  parseThreadSegmentFromAttachmentId,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
} from "../../attachmentStore.ts";
import * as ServerConfig from "../../config.ts";
import { parseBase64DataUrl } from "../../imageMime.ts";
import type { PreparedLegacyOutboxCommand } from "./OrchestrationCommandDispatchWorkflow.ts";

const decodeNativeCommand = Schema.decodeUnknownEffect(OrchestrationCommand);

function asDispatchError(message: string, cause?: unknown): OrchestrationDispatchCommandError {
  return new OrchestrationDispatchCommandError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

type PreparedAttachment = {
  readonly attachment: ChatAttachment;
  readonly materialize: Effect.Effect<void, OrchestrationDispatchCommandError>;
};

/**
 * Builds the V2 command body for a legacy outbox envelope. The returned
 * materializers are intentionally inert until the caller has proved the
 * original receipt and claimed its preprocessing row.
 */
export const makeLegacyOutboxPreparer = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;

  const prepareImage = (
    command: LegacyOutboxCommand,
    attachment: Extract<LegacyOutboxCommand["message"]["attachments"][number], { dataUrl: string }>,
    index: number,
  ): Effect.Effect<PreparedAttachment, OrchestrationDispatchCommandError> => {
    const parsed = parseBase64DataUrl(attachment.dataUrl);
    if (parsed === null || !parsed.mimeType.toLowerCase().startsWith("image/")) {
      return Effect.fail(
        asDispatchError(`Invalid image attachment payload for '${attachment.name}'.`),
      );
    }

    const bytes = Buffer.from(parsed.base64, "base64");
    if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
      return Effect.fail(
        asDispatchError(`Image attachment '${attachment.name}' is empty or too large.`),
      );
    }
    if (
      attachment.mimeType.toLowerCase() !== parsed.mimeType.toLowerCase() ||
      attachment.sizeBytes !== bytes.byteLength
    ) {
      return Effect.fail(
        asDispatchError(
          `Image attachment metadata does not match the payload for '${attachment.name}'.`,
        ),
      );
    }

    const contentDigest = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
    const attachmentId = createDeterministicAttachmentId(
      command.threadId,
      `${command.commandId}\u0000${index}\u0000${attachment.name}\u0000${attachment.mimeType}\u0000${attachment.sizeBytes}\u0000${contentDigest}`,
    );
    if (attachmentId === null) {
      return Effect.fail(asDispatchError("Failed to create a safe attachment id."));
    }

    const persistedAttachment: ChatAttachment = {
      type: "image",
      id: attachmentId,
      name: attachment.name,
      mimeType: parsed.mimeType.toLowerCase(),
      sizeBytes: bytes.byteLength,
    };
    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: serverConfig.attachmentsDir,
      attachment: persistedAttachment,
    });
    if (attachmentPath === null) {
      return Effect.fail(
        asDispatchError(`Failed to resolve persisted path for '${attachment.name}'.`),
      );
    }
    const pendingPath = `${attachmentPath}.${contentDigest}.pending`;

    const materialize = Effect.gen(function* () {
      const existing = yield* fileSystem.readFile(attachmentPath).pipe(
        Effect.map((value) => Buffer.from(value)),
        Effect.orElseSucceed(() => null),
      );
      if (existing?.equals(bytes)) {
        yield* fileSystem.remove(pendingPath, { force: true }).pipe(Effect.ignore);
        return;
      }
      if (existing !== null) {
        return yield* asDispatchError(
          `Persisted attachment identity collision for '${attachment.name}'.`,
        );
      }
      yield* fileSystem
        .makeDirectory(path.dirname(attachmentPath), { recursive: true })
        .pipe(
          Effect.mapError(() =>
            asDispatchError(`Failed to create attachment directory for '${attachment.name}'.`),
          ),
        );
      yield* Effect.gen(function* () {
        yield* fileSystem.writeFile(pendingPath, bytes);
        yield* fileSystem
          .link(pendingPath, attachmentPath)
          .pipe(
            Effect.catch(() =>
              fileSystem
                .readFile(attachmentPath)
                .pipe(
                  Effect.flatMap((value) =>
                    Buffer.from(value).equals(bytes)
                      ? Effect.void
                      : Effect.fail(
                          asDispatchError(
                            `Persisted attachment identity collision for '${attachment.name}'.`,
                          ),
                        ),
                  ),
                ),
            ),
          );
      }).pipe(
        Effect.mapError((cause) =>
          Schema.is(OrchestrationDispatchCommandError)(cause)
            ? cause
            : asDispatchError(`Failed to persist attachment '${attachment.name}'.`, cause),
        ),
        Effect.ensuring(fileSystem.remove(pendingPath, { force: true }).pipe(Effect.ignore)),
      );
    });

    return Effect.succeed({ attachment: persistedAttachment, materialize });
  };

  return (
    original: LegacyOutboxCommand,
  ): Effect.Effect<PreparedLegacyOutboxCommand, OrchestrationDispatchCommandError> =>
    Effect.gen(function* () {
      const preparedAttachments = yield* Effect.forEach(
        original.message.attachments,
        (attachment, index) =>
          "dataUrl" in attachment
            ? prepareImage(original, attachment, index)
            : Effect.gen(function* () {
                if (
                  parseThreadSegmentFromAttachmentId(attachment.id) !==
                  PENDING_ATTACHMENT_THREAD_SEGMENT
                ) {
                  return { attachment, materialize: Effect.void };
                }
                const claim = planAttachmentClaim({
                  attachmentsDir: serverConfig.attachmentsDir,
                  threadId: original.threadId,
                  attachmentId: attachment.id,
                });
                if (!claim.ok) return yield* asDispatchError(claim.reason);
                const normalized = {
                  ...attachment,
                  id: claim.finalId,
                  mimeType: attachment.mimeType.toLowerCase(),
                };
                if (
                  resolveAttachmentPath({
                    attachmentsDir: serverConfig.attachmentsDir,
                    attachment: normalized,
                  }) !== claim.finalPath
                ) {
                  return yield* asDispatchError(
                    "The uploaded attachment type does not match its file.",
                  );
                }
                return {
                  attachment: normalized,
                  materialize: Effect.gen(function* () {
                    if (yield* fileSystem.exists(claim.finalPath)) return;
                    if (claim.currentPath === null)
                      return yield* asDispatchError(
                        "The pending upload expired before it was delivered.",
                      );
                    const info = yield* fileSystem.stat(claim.currentPath);
                    if (Number(info.size) !== attachment.sizeBytes)
                      return yield* asDispatchError(
                        "The uploaded attachment size does not match its file.",
                      );
                    yield* fileSystem.copyFile(claim.currentPath, claim.finalPath);
                  }).pipe(
                    Effect.mapError((cause) =>
                      asDispatchError("Could not claim the saved attachment.", cause),
                    ),
                  ),
                };
              }),
        { concurrency: 1 },
      );
      const command = yield* decodeNativeCommand({
        ...original,
        message: {
          ...original.message,
          attachments: preparedAttachments.map(({ attachment }) => attachment),
        },
      }).pipe(
        Effect.mapError((cause) =>
          asDispatchError("The legacy outbox command could not be prepared for V2.", cause),
        ),
      );
      const rows = yield* sql<{ fingerprint: string | null; timestamp: string }>`
        SELECT envelope_fingerprint AS fingerprint, created_at AS timestamp
        FROM orchestration_command_preprocessing WHERE command_id = ${original.commandId}
        UNION ALL
        SELECT envelope_fingerprint AS fingerprint, accepted_at AS timestamp
        FROM orchestration_command_receipts
        WHERE command_id = ${original.commandId} AND command_type = 'legacy'
      `.pipe(
        Effect.mapError((cause) =>
          asDispatchError("Could not read the saved command identity.", cause),
        ),
      );
      let receiptCommand: LegacyOutboxCommand | OrchestrationCommand = original;
      const fingerprints = rows.flatMap((row) =>
        row.fingerprint === null ? [] : [row.fingerprint],
      );
      if (
        fingerprints.length > 0 &&
        !fingerprints.every((fingerprint) => fingerprint === commandEnvelopeFingerprint(original))
      ) {
        // V1 fingerprints the normalized attachments and server-received timestamp.
        // Recover only a candidate whose complete envelope matches the saved hash.
        const eventTimes = yield* sql<{ timestamp: string }>`
          SELECT DISTINCT occurred_at AS timestamp FROM orchestration_events
          WHERE stream_id = ${original.threadId}
            AND (command_id = ${original.commandId} OR event_type = 'thread.created')
          ORDER BY sequence LIMIT 32
        `.pipe(
          Effect.mapError((cause) =>
            asDispatchError("Could not read the saved command timestamps.", cause),
          ),
        );
        const timestamps = new Set([
          original.createdAt,
          ...rows.map((row) => row.timestamp),
          ...eventTimes.map((row) => row.timestamp),
        ]);
        const candidates = [...timestamps].map((createdAt) => ({
          ...command,
          createdAt,
          ...(command.type === "thread.turn.start" && command.bootstrap?.createThread
            ? {
                bootstrap: {
                  ...command.bootstrap,
                  createThread: { ...command.bootstrap.createThread, createdAt },
                },
              }
            : {}),
        }));
        const matching = candidates.find((candidate) =>
          fingerprints.every(
            (fingerprint) => fingerprint === commandEnvelopeFingerprint(candidate),
          ),
        );
        if (matching === undefined) {
          return yield* asDispatchError(
            "This saved message cannot be matched to its pre-upgrade receipt. Its setup has not been rerun. Review the thread before sending it again.",
          );
        }
        receiptCommand = matching;
      }
      return {
        command,
        receiptCommand,
        performDeferredPreprocessing: Effect.forEach(
          preparedAttachments,
          ({ materialize }) => materialize,
          { concurrency: 1, discard: true },
        ),
      } satisfies PreparedLegacyOutboxCommand;
    });
});
