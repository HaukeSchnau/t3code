// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  CommandId,
  MessageId,
  ThreadId,
  type ChatAttachment,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import {
  createDeterministicAttachmentId,
  createPendingAttachmentId,
  parseThreadSegmentFromAttachmentId,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { commandEnvelopeFingerprint } from "../orchestration/CommandEnvelope.ts";
import {
  CommandPreprocessingCoordinator,
  layer as CommandPreprocessingCoordinatorLive,
} from "../orchestration/Services/CommandPreprocessingCoordinator.ts";
import {
  attachmentIsPendingUpload,
  AttachmentClaimError,
  claimPendingAttachments,
  normalizePendingAttachmentReferences,
  releaseClaimedAttachments,
} from "./AttachmentClaims.ts";

const testLayer = Layer.mergeAll(NodeServices.layer).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-attachment-claims-" })),
  Layer.provideMerge(NodeServices.layer),
);

const concurrencyTestLayer = CommandPreprocessingCoordinatorLive.pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
  Layer.provideMerge(testLayer),
);

const stagePendingUpload = Effect.fn("test.stagePendingUpload")(function* (input: {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}) {
  const config = yield* ServerConfig.ServerConfig;
  const pendingId = createPendingAttachmentId();
  const attachment: ChatAttachment = {
    type: "image",
    id: ChatAttachmentId.make(pendingId!),
    name: input.name,
    mimeType: input.mimeType,
    sizeBytes: input.bytes.byteLength,
  };
  yield* Effect.sync(() => {
    NodeFS.mkdirSync(config.attachmentsDir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(config.attachmentsDir, `${pendingId}.png`), input.bytes);
  });
  return attachment;
});

describe("AttachmentClaims", () => {
  it("normalizes pending refs deterministically without reading the attachment store", () => {
    const pendingId = createPendingAttachmentId();
    const pending: ChatAttachment = {
      type: "image",
      id: ChatAttachmentId.make(pendingId),
      name: "missing.png",
      mimeType: "IMAGE/PNG",
      sizeBytes: 4,
    };

    const normalized = normalizePendingAttachmentReferences({
      threadId: "thread-native-replay",
      attachments: [pending],
    });

    expect(normalized).toEqual({
      ok: true,
      attachments: [
        {
          ...pending,
          id: ChatAttachmentId.make(
            createDeterministicAttachmentId("thread-native-replay", pendingId)!,
          ),
          mimeType: "image/png",
        },
      ],
    });
  });

  it("rejects a pending ref whose declared extension disagrees with its type", () => {
    const pendingId = createPendingAttachmentId(".pdf");
    const result = normalizePendingAttachmentReferences({
      threadId: "thread-native-replay",
      attachments: [
        {
          type: "image",
          id: ChatAttachmentId.make(pendingId),
          name: "image.png",
          mimeType: "image/png",
          sizeBytes: 4,
        },
      ],
    });

    expect(result).toEqual({ ok: false, reason: "attachment type does not match the upload" });
  });

  it.effect("claims a pending upload into the thread store and rewrites the id", () =>
    Effect.gen(function* () {
      const pending = yield* stagePendingUpload({
        name: "screenshot.png",
        bytes: new Uint8Array([1, 2, 3, 4]),
        mimeType: "image/png",
      });
      const config = yield* ServerConfig.ServerConfig;

      const claimed = yield* claimPendingAttachments({
        threadId: "thread-claims-1",
        attachments: [pending],
      });

      expect(claimed.attachments).toHaveLength(1);
      const attachment = claimed.attachments[0]!;
      expect(attachmentIsPendingUpload(attachment)).toBe(false);
      expect(parseThreadSegmentFromAttachmentId(attachment.id)).toBe("thread-claims-1");
      expect(claimed.claimedPaths).toHaveLength(1);
      expect(NodeFS.existsSync(claimed.claimedPaths[0]!)).toBe(true);
      // The pending copy stays behind as the retry source.
      const pendingFiles = NodeFS.readdirSync(config.attachmentsDir).filter((entry) =>
        entry.startsWith("pending-"),
      );
      expect(pendingFiles).toHaveLength(1);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("retries a claim with the same id without overwriting the delivered file", () =>
    Effect.gen(function* () {
      const pending = yield* stagePendingUpload({
        name: "retry.png",
        bytes: new Uint8Array([1, 2, 3, 4]),
        mimeType: "image/png",
      });
      const config = yield* ServerConfig.ServerConfig;

      const first = yield* claimPendingAttachments({
        threadId: "thread-claims-retry",
        attachments: [pending],
      });
      const delivered = first.claimedPaths[0]!;
      NodeFS.writeFileSync(delivered, Buffer.from("edited after delivery"));

      const retried = yield* claimPendingAttachments({
        threadId: "thread-claims-retry",
        attachments: [pending],
      });
      expect(retried.attachments[0]!.id).toBe(first.attachments[0]!.id);
      expect(retried.claimedPaths).toHaveLength(0);
      expect(NodeFS.readFileSync(delivered, "utf8")).toBe("edited after delivery");
      expect(NodeFS.existsSync(NodePath.join(config.attachmentsDir, `${pending.id}.png`))).toBe(
        true,
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("serializes pending retries and rejects a changed envelope before materialization", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const pending = yield* stagePendingUpload({
          name: "concurrent-retry.png",
          bytes: new Uint8Array([1, 2, 3, 4]),
          mimeType: "image/png",
        });
        const commandId = CommandId.make("command-attachment-concurrent-retry");
        const command = {
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId,
          threadId: ThreadId.make("thread-attachment-concurrent-retry"),
          messageId: MessageId.make("message-attachment-concurrent-retry"),
          text: "send this",
          attachments: [pending],
          dispatchMode: { type: "start_immediately" },
        } satisfies Extract<OrchestrationV2Command, { type: "message.dispatch" }>;
        const changed = {
          ...command,
          text: "tampered while the first request was pending",
        } satisfies Extract<OrchestrationV2Command, { type: "message.dispatch" }>;
        const normalizeCommand = (
          candidate: Extract<OrchestrationV2Command, { type: "message.dispatch" }>,
        ) => {
          const normalized = normalizePendingAttachmentReferences({
            threadId: candidate.threadId,
            attachments: candidate.attachments,
          });
          if (!normalized.ok) return candidate;
          return {
            ...candidate,
            attachments: normalized.attachments,
          } satisfies Extract<OrchestrationV2Command, { type: "message.dispatch" }>;
        };
        const normalizedCommand = normalizeCommand(command);
        const normalizedChanged = normalizeCommand(changed);
        const receiptFingerprint = yield* Ref.make<string | null>(null);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const coordinator = yield* CommandPreprocessingCoordinator;

        const dispatchNative = (
          candidate: Extract<OrchestrationV2Command, { type: "message.dispatch" }>,
          normalized: Extract<OrchestrationV2Command, { type: "message.dispatch" }>,
          pauseAfterClaim = false,
        ) =>
          coordinator.withCommandLock(
            candidate.commandId,
            Effect.gen(function* () {
              const fingerprint = commandEnvelopeFingerprint(normalized);
              const previousFingerprint = yield* Ref.get(receiptFingerprint);
              if (previousFingerprint !== null) {
                if (previousFingerprint !== fingerprint) {
                  return yield* new AttachmentClaimError({
                    message: "native command receipt mismatch",
                  });
                }
                return {
                  attachments: normalized.attachments,
                  claimedPaths: [],
                };
              }
              // This is the native intake ordering: only an unreceipted
              // envelope may materialize a pending upload.
              const claimed = yield* claimPendingAttachments({
                threadId: normalized.threadId,
                attachments: candidate.attachments,
              });
              yield* Ref.set(receiptFingerprint, fingerprint);
              if (pauseAfterClaim) {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
              }
              return claimed;
            }),
          );

        const first = yield* dispatchNative(command, normalizedCommand, true)
          .pipe(Effect.forkScoped);
        yield* Deferred.await(entered);

        const changedRetry = yield* dispatchNative(changed, normalizedChanged)
          .pipe(Effect.result, Effect.forkScoped);

        yield* Deferred.succeed(release, undefined);
        const firstClaim = yield* Fiber.join(first);
        const changedResult = yield* Fiber.join(changedRetry);
        expect(firstClaim.claimedPaths).toHaveLength(1);
        expect(changedResult._tag).toBe("Failure");

        const delivered = firstClaim.claimedPaths[0]!;
        NodeFS.writeFileSync(delivered, Buffer.from("authoritative delivered copy"));
        const retried = yield* dispatchNative(command, normalizedCommand);
        expect(retried.claimedPaths).toHaveLength(0);
        expect(NodeFS.readFileSync(delivered, "utf8")).toBe("authoritative delivered copy");
        expect(NodeFS.existsSync(delivered)).toBe(true);
      }),
    ).pipe(Effect.provide(concurrencyTestLayer)),
  );

  it.effect("reuses a delivered file when the pending source has expired", () =>
    Effect.gen(function* () {
      const pending = yield* stagePendingUpload({
        name: "expired.png",
        bytes: new Uint8Array([5, 6, 7]),
        mimeType: "image/png",
      });

      const first = yield* claimPendingAttachments({
        threadId: "thread-claims-expired",
        attachments: [pending],
      });
      const delivered = first.claimedPaths[0]!;
      NodeFS.writeFileSync(delivered, Buffer.from("kept delivered content"));
      const config = yield* ServerConfig.ServerConfig;
      NodeFS.unlinkSync(NodePath.join(config.attachmentsDir, `${pending.id}.png`));

      const retried = yield* claimPendingAttachments({
        threadId: "thread-claims-expired",
        attachments: [pending],
      });
      expect(retried.attachments[0]!.id).toBe(first.attachments[0]!.id);
      expect(retried.claimedPaths).toHaveLength(0);
      expect(NodeFS.readFileSync(delivered, "utf8")).toBe("kept delivered content");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("passes already-claimed attachments through untouched", () =>
    Effect.gen(function* () {
      const stored: ChatAttachment = {
        type: "image",
        id: ChatAttachmentId.make("thread-claims-2-00000000-0000-4000-8000-000000000001"),
        name: "existing.png",
        mimeType: "image/png",
        sizeBytes: 4,
      };
      const claimed = yield* claimPendingAttachments({
        threadId: "thread-claims-2",
        attachments: [stored],
      });
      expect(claimed.attachments[0]).toBe(stored);
      expect(claimed.claimedPaths).toHaveLength(0);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects a pending ref whose staged file is missing", () =>
    Effect.gen(function* () {
      const missing: ChatAttachment = {
        type: "image",
        id: ChatAttachmentId.make(createPendingAttachmentId()!),
        name: "gone.png",
        mimeType: "image/png",
        sizeBytes: 4,
      };
      const result = yield* Effect.exit(
        claimPendingAttachments({ threadId: "thread-claims-3", attachments: [missing] }),
      );
      expect(result._tag).toBe("Failure");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects a size mismatch and cleans up earlier claims from the batch", () =>
    Effect.gen(function* () {
      const good = yield* stagePendingUpload({
        name: "one.png",
        bytes: new Uint8Array([1, 2, 3, 4]),
        mimeType: "image/png",
      });
      const staged = yield* stagePendingUpload({
        name: "two.png",
        bytes: new Uint8Array([1, 2, 3, 4]),
        mimeType: "image/png",
      });
      const mismatched = { ...staged, sizeBytes: 999 };
      const config = yield* ServerConfig.ServerConfig;

      const result = yield* Effect.exit(
        claimPendingAttachments({
          threadId: "thread-claims-4",
          attachments: [good, mismatched],
        }),
      );

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        const error = result.cause;
        expect(String(error)).toContain("stored size does not match");
      }
      // The successfully claimed first attachment was rolled back.
      const claimedFiles = NodeFS.readdirSync(config.attachmentsDir).filter((entry) =>
        entry.startsWith("thread-claims-4-"),
      );
      expect(claimedFiles).toHaveLength(0);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps an earlier delivered file when a later retry fails", () =>
    Effect.gen(function* () {
      const pending = yield* stagePendingUpload({
        name: "committed.png",
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: "image/png",
      });
      const bad = yield* stagePendingUpload({
        name: "bad.png",
        bytes: new Uint8Array([4, 5]),
        mimeType: "image/png",
      });
      const first = yield* claimPendingAttachments({
        threadId: "thread-claims-committed",
        attachments: [pending],
      });
      const delivered = first.claimedPaths[0]!;
      NodeFS.writeFileSync(delivered, Buffer.from("committed"));

      const result = yield* Effect.exit(
        claimPendingAttachments({
          threadId: "thread-claims-committed",
          attachments: [pending, { ...bad, sizeBytes: 999 }],
        }),
      );
      expect(result._tag).toBe("Failure");
      expect(NodeFS.readFileSync(delivered, "utf8")).toBe("committed");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("releaseClaimedAttachments removes claimed copies best-effort", () =>
    Effect.gen(function* () {
      const pending = yield* stagePendingUpload({
        name: "release.png",
        bytes: new Uint8Array([9, 9]),
        mimeType: "image/png",
      });
      const claimed = yield* claimPendingAttachments({
        threadId: "thread-claims-5",
        attachments: [pending],
      });
      expect(NodeFS.existsSync(claimed.claimedPaths[0]!)).toBe(true);
      yield* releaseClaimedAttachments(claimed.claimedPaths);
      expect(NodeFS.existsSync(claimed.claimedPaths[0]!)).toBe(false);
      // Releasing again is a no-op, not an error.
      yield* releaseClaimedAttachments(claimed.claimedPaths);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("treats malformed ids as non-pending and passes them through", () =>
    Effect.gen(function* () {
      // Not a parseable pending ref: nothing to claim, so the ref flows
      // through unchanged and downstream delivery decides what to do with it.
      const bogus: ChatAttachment = {
        type: "image",
        id: ChatAttachmentId.make("pending-not-a-uuid"),
        name: "weird.png",
        mimeType: "image/png",
        sizeBytes: 1,
      };
      const claimed = yield* claimPendingAttachments({
        threadId: "thread-claims-6",
        attachments: [bogus],
      });
      expect(claimed.attachments[0]).toBe(bogus);
      expect(claimed.claimedPaths).toHaveLength(0);
    }).pipe(Effect.provide(testLayer)),
  );
});
