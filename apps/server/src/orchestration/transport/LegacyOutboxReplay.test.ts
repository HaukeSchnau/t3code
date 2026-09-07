// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type LegacyOutboxCommand,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  createDeterministicAttachmentId,
  createPendingAttachmentId,
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPath,
} from "../../attachmentStore.ts";
import * as ServerConfig from "../../config.ts";
import { commandEnvelopeFingerprint } from "../CommandEnvelope.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { makeLegacyOutboxPreparer } from "./LegacyOutboxReplay.ts";

type LegacyTurnStartCommand = Extract<LegacyOutboxCommand, { readonly type: "thread.turn.start" }>;
type NativeTurnStartCommand = Extract<OrchestrationCommand, { readonly type: "thread.turn.start" }>;

const timestamp = "2026-01-01T00:00:00.000Z";
const threadId = ThreadId.make("legacy-replay-preparer-thread");
const projectId = ProjectId.make("legacy-replay-preparer-project");
const imageBytes = Buffer.from([1, 2]);

const testLayer = SqlitePersistenceMemory.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-legacy-outbox-replay-" })),
  Layer.provideMerge(NodeServices.layer),
);

function legacyCommand(
  commandId: string,
  input: {
    readonly createdAt?: string;
    readonly attachments?: LegacyTurnStartCommand["message"]["attachments"];
  } = {},
): LegacyTurnStartCommand {
  return {
    type: "thread.turn.start",
    commandId: CommandId.make(commandId),
    threadId,
    message: {
      messageId: MessageId.make(`${commandId}-message`),
      role: "user",
      text: "continue the task",
      attachments: input.attachments ?? [
        {
          type: "image",
          name: "capture.png",
          mimeType: "IMAGE/PNG",
          sizeBytes: imageBytes.byteLength,
          dataUrl: `data:image/png;base64,${imageBytes.toString("base64")}`,
        },
      ],
    },
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    bootstrap: {
      createThread: {
        projectId,
        title: "Legacy replay",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/tmp/legacy-replay-worktree",
        createdAt: input.createdAt ?? timestamp,
      },
      runSetupScript: true,
    },
    createdAt: input.createdAt ?? timestamp,
  } as LegacyTurnStartCommand;
}

function oldNormalizedCommand(
  command: LegacyTurnStartCommand,
  createdAt: string,
): NativeTurnStartCommand {
  const sourceAttachment = command.message.attachments[0];
  if (!sourceAttachment || !("dataUrl" in sourceAttachment)) {
    throw new Error("The legacy fixture must contain an inline image.");
  }
  const contentDigest = NodeCrypto.createHash("sha256").update(imageBytes).digest("hex");
  const attachmentId = createDeterministicAttachmentId(
    command.threadId,
    `${command.commandId}\u0000${0}\u0000${sourceAttachment.name}\u0000${sourceAttachment.mimeType}\u0000${sourceAttachment.sizeBytes}\u0000${contentDigest}`,
  );
  if (attachmentId === null) throw new Error("The fixture attachment id could not be generated.");

  return {
    ...command,
    createdAt,
    message: {
      ...command.message,
      attachments: [
        {
          type: "image",
          id: attachmentId,
          name: sourceAttachment.name,
          mimeType: "image/png",
          sizeBytes: imageBytes.byteLength,
        },
      ],
    },
    bootstrap: command.bootstrap?.createThread
      ? {
          ...command.bootstrap,
          createThread: {
            ...command.bootstrap.createThread,
            createdAt,
          },
        }
      : command.bootstrap,
  } as unknown as NativeTurnStartCommand;
}

const insertLegacyPreprocessing = (input: {
  readonly command: LegacyOutboxCommand;
  readonly fingerprint: string;
  readonly createdAt: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_command_preprocessing (
        command_id,
        aggregate_kind,
        aggregate_id,
        command_variant,
        envelope_fingerprint,
        created_at,
        updated_at
      ) VALUES (
        ${input.command.commandId},
        'thread',
        ${input.command.threadId},
        ${input.command.type},
        ${input.fingerprint},
        ${input.createdAt},
        ${input.createdAt}
      )
    `;
  });

const insertLegacyReceipt = (input: {
  readonly command: LegacyOutboxCommand;
  readonly fingerprint: string;
  readonly acceptedAt: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_command_receipts (
        command_id,
        aggregate_kind,
        aggregate_id,
        command_type,
        command_variant,
        envelope_fingerprint,
        accepted_at,
        result_sequence,
        status,
        error
      ) VALUES (
        ${input.command.commandId},
        'thread',
        ${input.command.threadId},
        'legacy',
        ${input.command.type},
        ${input.fingerprint},
        ${input.acceptedAt},
        7,
        'accepted',
        NULL
      )
    `;
  });

const insertThreadCreatedEvent = (input: {
  readonly command: LegacyOutboxCommand;
  readonly occurredAt: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_events (
        event_id,
        aggregate_kind,
        stream_id,
        stream_version,
        event_type,
        occurred_at,
        command_id,
        causation_event_id,
        correlation_id,
        actor_kind,
        payload_json,
        metadata_json
      ) VALUES (
        ${`event:${input.command.commandId}`},
        'thread',
        ${input.command.threadId},
        1,
        'thread.created',
        ${input.occurredAt},
        NULL,
        NULL,
        NULL,
        'user',
        '{}',
        '{}'
      )
    `;
  });

it.effect("normalizes images and defers attachment materialization", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const prepare = yield* makeLegacyOutboxPreparer;
    const original = legacyCommand("legacy-inline-image");

    const prepared = yield* prepare(original);
    const normalized = (prepared.command as NativeTurnStartCommand).message.attachments[0];
    assert.equal(normalized?.type, "image");
    if (normalized?.type !== "image") throw new Error("Expected a normalized image.");
    expect(normalized.mimeType).toBe("image/png");
    expect(normalized.sizeBytes).toBe(imageBytes.byteLength);
    expect("dataUrl" in normalized).toBe(false);
    expect(original.message.attachments[0]).toHaveProperty("dataUrl");

    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment: normalized,
    });
    expect(attachmentPath).not.toBeNull();
    expect(yield* fileSystem.exists(attachmentPath!)).toBe(false);

    yield* prepared.performDeferredPreprocessing;
    expect(yield* fileSystem.exists(attachmentPath!)).toBe(true);
    expect(Buffer.from(yield* fileSystem.readFile(attachmentPath!))).toEqual(imageBytes);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("normalizes pending uploads and materializes them only after receipt validation", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const pendingId = createPendingAttachmentId(".png");
    const pending = {
      type: "image" as const,
      id: pendingId,
      name: "pending.png",
      mimeType: "image/png",
      sizeBytes: imageBytes.byteLength,
    };
    const pendingPath = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment: pending,
    });
    expect(pendingPath).not.toBeNull();
    yield* fileSystem.writeFile(pendingPath!, imageBytes);

    const prepare = yield* makeLegacyOutboxPreparer;
    const prepared = yield* prepare(
      legacyCommand("legacy-pending-upload", { attachments: [pending] }),
    );
    const normalized = (prepared.command as NativeTurnStartCommand).message.attachments[0];
    assert.equal(normalized?.type, "image");
    if (normalized?.type !== "image") throw new Error("Expected a normalized image.");
    expect(parseThreadSegmentFromAttachmentId(normalized.id)).toBe(threadId);
    const finalPath = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment: normalized,
    });
    expect(finalPath).not.toBeNull();
    expect(yield* fileSystem.exists(finalPath!)).toBe(false);

    yield* prepared.performDeferredPreprocessing;
    expect(yield* fileSystem.exists(finalPath!)).toBe(true);
    expect(Buffer.from(yield* fileSystem.readFile(finalPath!))).toEqual(imageBytes);
    expect(yield* fileSystem.exists(pendingPath!)).toBe(true);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("recovers the exact old normalized envelope from a thread event timestamp", () =>
  Effect.gen(function* () {
    const oldReceivedAt = "2025-12-31T23:59:59.000Z";
    const original = legacyCommand("legacy-history-recovery", { createdAt: timestamp });
    const oldNormalized = oldNormalizedCommand(original, oldReceivedAt);
    yield* insertLegacyReceipt({
      command: original,
      fingerprint: commandEnvelopeFingerprint(oldNormalized),
      acceptedAt: "2026-01-01T00:00:05.000Z",
    });
    yield* insertThreadCreatedEvent({ command: original, occurredAt: oldReceivedAt });

    const prepare = yield* makeLegacyOutboxPreparer;
    const prepared = yield* prepare(original);
    expect((prepared.command as NativeTurnStartCommand).createdAt).toBe(timestamp);
    const receiptCommand = prepared.receiptCommand;
    expect(receiptCommand).toBeDefined();
    if (!receiptCommand || receiptCommand.type !== "thread.turn.start") {
      throw new Error("Expected a recovered turn-start receipt command.");
    }
    expect(commandEnvelopeFingerprint(receiptCommand)).toBe(
      commandEnvelopeFingerprint(oldNormalized),
    );
    expect(receiptCommand.createdAt).toBe(oldReceivedAt);
    expect(receiptCommand.bootstrap?.createThread?.createdAt).toBe(oldReceivedAt);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("fails safely when historical progress cannot match the full envelope", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const original = legacyCommand("legacy-unmatchable-history");
    const normalized = oldNormalizedCommand(original, "2025-12-31T23:59:59.000Z");
    yield* insertLegacyPreprocessing({
      command: original,
      fingerprint: commandEnvelopeFingerprint({
        ...normalized,
        message: { ...normalized.message, text: "different" },
      }),
      createdAt: "2026-01-01T00:00:05.000Z",
    });

    const prepare = yield* makeLegacyOutboxPreparer;
    const result = yield* Effect.result(prepare(original));
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") {
      expect(result.failure.message).toContain("cannot be matched to its pre-upgrade receipt");
      expect(result.failure.message).toContain("setup has not been rerun");
    }

    const normalizedAttachment = normalized.message.attachments[0];
    if (normalizedAttachment?.type === "image") {
      const attachmentPath = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment: normalizedAttachment,
      });
      expect(attachmentPath).not.toBeNull();
      expect(yield* fileSystem.exists(attachmentPath!)).toBe(false);
    }
  }).pipe(Effect.provide(testLayer)),
);
