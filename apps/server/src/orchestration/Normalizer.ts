// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  type ClientOrchestrationCommand,
  type IsoDateTime,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";

import { createDeterministicAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { parseBase64DataUrl } from "../imageMime.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);

export interface PreparedDispatchCommand {
  readonly command: OrchestrationCommand;
  readonly performDeferredPreprocessing: Effect.Effect<void, OrchestrationDispatchCommandError>;
}

export const canonicalizeClientCommandTimestamps = (
  command: ClientOrchestrationCommand,
  receivedAt: IsoDateTime,
): ClientOrchestrationCommand => {
  const canonicalCommand =
    "createdAt" in command
      ? {
          ...command,
          createdAt: receivedAt,
        }
      : command;

  if (canonicalCommand.type !== "thread.turn.start" || !canonicalCommand.bootstrap?.createThread) {
    return canonicalCommand;
  }

  return {
    ...canonicalCommand,
    bootstrap: {
      ...canonicalCommand.bootstrap,
      createThread: {
        ...canonicalCommand.bootstrap.createThread,
        createdAt: receivedAt,
      },
    },
  };
};

export const prepareDispatchCommand = (command: ClientOrchestrationCommand) =>
  Effect.gen(function* () {
    const receivedAt = DateTime.formatIso(yield* DateTime.now);
    const canonicalCommand = canonicalizeClientCommandTimestamps(command, receivedAt);
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;
    const workspacePaths = yield* WorkspacePaths.WorkspacePaths;

    const normalizeProjectWorkspaceRoot = (workspaceRoot: string) =>
      workspacePaths.normalizeWorkspaceRoot(workspaceRoot).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationDispatchCommandError({
              message: cause.message,
            }),
        ),
      );

    const normalizeProjectWorkspaceRootForCreate = (
      workspaceRoot: string,
      createIfMissing: boolean | undefined,
    ) =>
      workspacePaths
        .normalizeWorkspaceRoot(workspaceRoot, {
          createIfMissing: createIfMissing === true,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationDispatchCommandError({
                message: cause.message,
              }),
          ),
        );

    if (canonicalCommand.type === "project.create") {
      const workspaceRoot = workspacePaths.canonicalizeWorkspaceRoot(
        canonicalCommand.workspaceRoot,
      );
      return {
        command: {
          ...canonicalCommand,
          workspaceRoot,
          createWorkspaceRootIfMissing: canonicalCommand.createWorkspaceRootIfMissing === true,
        },
        performDeferredPreprocessing: normalizeProjectWorkspaceRootForCreate(
          workspaceRoot,
          canonicalCommand.createWorkspaceRootIfMissing,
        ).pipe(Effect.asVoid),
      } satisfies PreparedDispatchCommand;
    }

    if (
      canonicalCommand.type === "project.meta.update" &&
      canonicalCommand.workspaceRoot !== undefined
    ) {
      const workspaceRoot = workspacePaths.canonicalizeWorkspaceRoot(
        canonicalCommand.workspaceRoot,
      );
      return {
        command: {
          ...canonicalCommand,
          workspaceRoot,
        },
        performDeferredPreprocessing: normalizeProjectWorkspaceRoot(workspaceRoot).pipe(
          Effect.asVoid,
        ),
      } satisfies PreparedDispatchCommand;
    }

    if (
      canonicalCommand.type !== "thread.turn.start" &&
      canonicalCommand.type !== "thread.message.queue"
    ) {
      return {
        command: canonicalCommand as OrchestrationCommand,
        performDeferredPreprocessing: Effect.void,
      } satisfies PreparedDispatchCommand;
    }

    const preparedAttachments = yield* Effect.forEach(
      canonicalCommand.message.attachments,
      (attachment, index) =>
        Effect.gen(function* () {
          const parsed = parseBase64DataUrl(attachment.dataUrl);
          if (!parsed || !parsed.mimeType.startsWith("image/")) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Invalid image attachment payload for '${attachment.name}'.`,
            });
          }

          const bytes = Buffer.from(parsed.base64, "base64");
          if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Image attachment '${attachment.name}' is empty or too large.`,
            });
          }
          if (
            attachment.mimeType.toLowerCase() !== parsed.mimeType.toLowerCase() ||
            attachment.sizeBytes !== bytes.byteLength
          ) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Image attachment metadata does not match the payload for '${attachment.name}'.`,
            });
          }

          const contentDigest = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
          const attachmentId = createDeterministicAttachmentId(
            canonicalCommand.threadId,
            `${canonicalCommand.commandId}\u0000${index}\u0000${attachment.name}\u0000${attachment.mimeType}\u0000${attachment.sizeBytes}\u0000${contentDigest}`,
          );
          if (!attachmentId) {
            return yield* new OrchestrationDispatchCommandError({
              message: "Failed to create a safe attachment id.",
            });
          }

          const persistedAttachment = {
            type: "image" as const,
            id: attachmentId,
            name: attachment.name,
            mimeType: parsed.mimeType.toLowerCase(),
            sizeBytes: bytes.byteLength,
          };
          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment: persistedAttachment,
          });
          if (!attachmentPath) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Failed to resolve persisted path for '${attachment.name}'.`,
            });
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
              return yield* new OrchestrationDispatchCommandError({
                message: `Persisted attachment identity collision for '${attachment.name}'.`,
              });
            }
            yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true }).pipe(
              Effect.mapError(
                () =>
                  new OrchestrationDispatchCommandError({
                    message: `Failed to create attachment directory for '${attachment.name}'.`,
                  }),
              ),
            );
            yield* Effect.gen(function* () {
              yield* fileSystem.writeFile(pendingPath, bytes);
              yield* fileSystem.link(pendingPath, attachmentPath).pipe(
                Effect.catch(() =>
                  fileSystem.readFile(attachmentPath).pipe(
                    Effect.flatMap((value) =>
                      Buffer.from(value).equals(bytes)
                        ? Effect.void
                        : Effect.fail(
                            new OrchestrationDispatchCommandError({
                              message: `Persisted attachment identity collision for '${attachment.name}'.`,
                            }),
                          ),
                    ),
                  ),
                ),
              );
            }).pipe(
              Effect.mapError((cause) =>
                isOrchestrationDispatchCommandError(cause)
                  ? cause
                  : new OrchestrationDispatchCommandError({
                      message: `Failed to persist attachment '${attachment.name}'.`,
                    }),
              ),
              Effect.ensuring(fileSystem.remove(pendingPath, { force: true }).pipe(Effect.ignore)),
            );
          });

          return { attachment: persistedAttachment, materialize };
        }),
      { concurrency: 1 },
    );

    return {
      command: {
        ...canonicalCommand,
        message: {
          ...canonicalCommand.message,
          attachments: preparedAttachments.map(({ attachment }) => attachment),
        },
      },
      performDeferredPreprocessing: Effect.forEach(
        preparedAttachments,
        ({ materialize }) => materialize,
        { concurrency: 1, discard: true },
      ),
    } satisfies PreparedDispatchCommand;
  });

export const normalizeDispatchCommand = (command: ClientOrchestrationCommand) =>
  prepareDispatchCommand(command).pipe(
    Effect.tap(({ performDeferredPreprocessing }) => performDeferredPreprocessing),
    Effect.map(({ command: normalizedCommand }) => normalizedCommand),
  );
