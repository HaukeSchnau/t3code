import { assert, it } from "@effect/vitest";
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
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { commandEnvelopeFingerprint } from "../../../orchestration/CommandEnvelope.ts";
import {
  CommandPreprocessingCoordinator,
  layer as CommandPreprocessingCoordinatorLive,
} from "../../../orchestration/Services/CommandPreprocessingCoordinator.ts";
import { EventSinkV2 } from "../../../orchestration-v2/EventSink.ts";
import { LegacyV1ThreadImporter } from "../../../orchestration-v2/LegacyV1ThreadImporter.ts";
import { ProjectionStoreV2 } from "../../../orchestration-v2/ProjectionStore.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../../../project/ProjectService.ts";
import { OrchestrationCommandReceiptRepository } from "../../../persistence/Services/OrchestrationCommandReceipts.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { ThreadCoordinationBackend, layer as bridgeLayer } from "./V2Bridge.ts";

type BridgeTestServices =
  | ThreadCoordinationBackend
  | OrchestrationCommandReceiptRepository
  | CommandPreprocessingCoordinator;

const threadId = ThreadId.make("thread-v2-bridge");
const projectId = ProjectId.make("project-v2-bridge");
const providerInstanceId = ProviderInstanceId.make("codex");

const uploadedImage = {
  type: "image" as const,
  name: "screenshot.png",
  mimeType: "image/png",
  sizeBytes: 1,
  dataUrl: "data:image/png;base64,AA==",
};

const storedImage = {
  type: "image" as const,
  id: "attachment-v2-bridge",
  name: uploadedImage.name,
  mimeType: uploadedImage.mimeType,
  sizeBytes: uploadedImage.sizeBytes,
};

const makeLegacyCommand = (commandId: string, text = "original envelope") => ({
  type: "thread.turn.start" as const,
  commandId: CommandId.make(commandId),
  threadId,
  message: {
    messageId: MessageId.make(`${commandId}-message`),
    role: "user" as const,
    text,
    attachments: [uploadedImage],
  },
  modelSelection: { instanceId: providerInstanceId, model: "gpt-5-codex" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
}) satisfies LegacyOutboxCommand;

const makePreparedCommand = (command: LegacyOutboxCommand): OrchestrationCommand => ({
  ...command,
  message: { ...command.message, attachments: [storedImage] },
}) as unknown as OrchestrationCommand;

const makeNativeBootstrapCommand = (commandId: string): OrchestrationCommand => ({
  type: "thread.turn.start",
  commandId: CommandId.make(commandId),
  threadId,
  message: {
    messageId: MessageId.make(`${commandId}-message`),
    role: "user",
    text: "bootstrap envelope",
    attachments: [],
  },
  modelSelection: { instanceId: providerInstanceId, model: "gpt-5-codex" },
  runtimeMode: "full-access",
  interactionMode: "default",
  bootstrap: {
    createThread: {
      projectId,
      title: "Bootstrap thread",
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  },
  createdAt: "2026-01-01T00:00:00.000Z",
});

const projectionStore = {
  getThreadShell: () => Effect.succeed(null),
  getShellSnapshot: () => Effect.succeed({ snapshotSequence: 0, threads: [] }),
};

const threadManagement = {
  dispatch: () => Effect.die("dispatch should not run for a verified receipt"),
  getThreadProjection: () => Effect.die("projection should not be read for a verified receipt"),
};

const importer = { ensureTranscript: () => Effect.void };
const projectService = {
  getById: () => Effect.succeed(Option.none()),
  snapshot: Effect.succeed({ projects: [] }),
};
const eventSink = { stream: () => Stream.empty };

const receiptLayer = OrchestrationCommandReceiptRepositoryLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
const preprocessingLayer = CommandPreprocessingCoordinatorLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);

const bridgeDependencies = Layer.mergeAll(
  Layer.succeed(ProjectionStoreV2, projectionStore as unknown as typeof ProjectionStoreV2.Service),
  Layer.succeed(ThreadManagementService, threadManagement as unknown as typeof ThreadManagementService.Service),
  Layer.succeed(LegacyV1ThreadImporter, importer as unknown as typeof LegacyV1ThreadImporter.Service),
  Layer.succeed(ProjectService, projectService as unknown as typeof ProjectService.Service),
  Layer.succeed(EventSinkV2, eventSink as unknown as typeof EventSinkV2.Service),
).pipe(Layer.provideMerge(SqlitePersistenceMemory));

const testLayer = bridgeLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(bridgeDependencies, receiptLayer, preprocessingLayer)),
);

const withBridge = <A, E>(effect: Effect.Effect<A, E, BridgeTestServices>) =>
  effect.pipe(Effect.provide(testLayer));

const acceptedLegacyReceipt = (command: LegacyOutboxCommand) => ({
  commandId: command.commandId,
  aggregateKind: "thread" as const,
  aggregateId: command.threadId,
  commandType: "legacy",
  commandVariant: command.type,
  envelopeFingerprint: commandEnvelopeFingerprint(command),
  acceptedAt: "2026-01-01T00:00:00.000Z",
  resultSequence: 42,
  status: "accepted" as const,
  error: null,
});

it.effect("retries a prepared legacy envelope against the original receipt", () =>
  withBridge(
    Effect.gen(function* () {
      const command = makeLegacyCommand("bridge-retry");
      const receipts = yield* OrchestrationCommandReceiptRepository;
      yield* receipts.upsert(acceptedLegacyReceipt(command));

      const bridge = yield* ThreadCoordinationBackend;
      const result = yield* bridge.engine.dispatchWithinCommandLock(
        makePreparedCommand(command),
        command,
      );

      assert.deepStrictEqual(result, { sequence: 42, storedEvents: [] });
    }),
  ),
);

it.effect("rejects a changed envelope under an existing command id", () =>
  withBridge(
    Effect.gen(function* () {
      const command = makeLegacyCommand("bridge-changed");
      const receipts = yield* OrchestrationCommandReceiptRepository;
      yield* receipts.upsert(acceptedLegacyReceipt(command));

      const bridge = yield* ThreadCoordinationBackend;
      const result = yield* Effect.result(
        bridge.engine.resolveReceipt({ ...command, message: { ...command.message, text: "changed envelope" } }),
      );

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.isTrue("code" in result.failure);
        if ("code" in result.failure) assert.equal(result.failure.code, "receipt_mismatch");
      }
    }),
  ),
);

it.effect("surfaces a preexisting rejected receipt without dispatching", () =>
  withBridge(
    Effect.gen(function* () {
      const command = makeLegacyCommand("bridge-rejected");
      const receipts = yield* OrchestrationCommandReceiptRepository;
      yield* receipts.upsert({
        ...acceptedLegacyReceipt(command),
        resultSequence: 0,
        status: "rejected",
        error: "provider rejected the turn",
      });

      const bridge = yield* ThreadCoordinationBackend;
      const result = yield* Effect.result(bridge.engine.resolveReceipt(command));

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.isTrue("code" in result.failure && "message" in result.failure);
        if ("code" in result.failure && "message" in result.failure) {
          assert.equal(result.failure.code, "previously_rejected");
          assert.equal(result.failure.message, "provider rejected the turn");
        }
      }
    }),
  ),
);

it.effect("uses the original bootstrap envelope when retrying a prepared native command", () =>
  withBridge(
    Effect.gen(function* () {
      const command = makeNativeBootstrapCommand("bridge-bootstrap");
      const preprocessing = yield* CommandPreprocessingCoordinator;
      yield* preprocessing.claim(command);

      const receipts = yield* OrchestrationCommandReceiptRepository;
      yield* receipts.upsert({
        commandId: command.commandId,
        aggregateKind: "thread",
        aggregateId: threadId,
        commandType: "message.dispatch",
        commandVariant: command.type,
        envelopeFingerprint: commandEnvelopeFingerprint(command),
        acceptedAt: "2026-01-01T00:00:00.000Z",
        resultSequence: 43,
        status: "accepted",
        error: null,
      });

      const prepared = { ...command, bootstrap: undefined } as unknown as OrchestrationCommand;
      const bridge = yield* ThreadCoordinationBackend;
      const result = yield* bridge.engine.dispatchWithinCommandLock(prepared, command);

      assert.deepStrictEqual(result, { sequence: 43, storedEvents: [] });
    }),
  ),
);
