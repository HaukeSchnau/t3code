import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CommandId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { OrchestrationCommandReceiptMismatchError, OrchestrationCommandPreviouslyRejectedError } from "../Errors.ts";
import { OrchestrationLayerLive } from "../runtimeLayer.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ServerConfig } from "../../config.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { ProjectEnrichmentService } from "../../project/ProjectEnrichmentService.ts";

const isReceiptMismatchError = Schema.is(OrchestrationCommandReceiptMismatchError);
const isPreviouslyRejectedError = Schema.is(OrchestrationCommandPreviouslyRejectedError);

const databaseLayer = SqlitePersistenceMemory.pipe(
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "orchestration-engine-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const layer = it.layer(
  OrchestrationLayerLive.pipe(
    Layer.provideMerge(databaseLayer),
    Layer.provide(
      Layer.succeed(ProjectEnrichmentService, {
        peek: () =>
          Effect.succeed({
            repositoryIdentity: null,
            faviconPath: null,
            repositoryIdentityResolved: false,
          }),
        request: () => Effect.void,
        getAvailable: () =>
          Effect.succeed({
            repositoryIdentity: null,
            faviconPath: null,
            repositoryIdentityResolved: false,
          }),
        invalidate: () => Effect.void,
        subscribeChanges: Effect.never,
      }),
    ),
  ),
);

const createProject = (commandId: CommandId, projectId: ProjectId, title: string) => ({
  type: "project.create" as const,
  commandId,
  projectId,
  title,
  workspaceRoot: `/tmp/${projectId}`,
  defaultModelSelection: null,
  createdAt: "2026-01-01T00:00:00.000Z",
});

layer("OrchestrationEngine", (it) => {
  it.effect("replays only an identical project command envelope", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const repository = yield* OrchestrationCommandReceiptRepository;
      const commandId = CommandId.make("command:engine-envelope");
      const projectId = ProjectId.make("project:engine-envelope");
      const command = createProject(commandId, projectId, "Original");

      const first = yield* engine.dispatch(command);
      const retry = yield* engine.dispatch(command);
      assert.equal(retry.sequence, first.sequence);

      const changed = yield* Effect.result(
        engine.dispatch(createProject(commandId, projectId, "Changed")),
      );
      assert.equal(changed._tag, "Failure");
      if (changed._tag === "Failure") {
        assert.isTrue(isReceiptMismatchError(changed.failure));
        if (isReceiptMismatchError(changed.failure)) {
          assert.equal(changed.failure.reason, "payload-mismatch");
        }
      }

      const receipt = Option.getOrThrow(yield* repository.getByCommandId({ commandId }));
      assert.equal(receipt.commandType, command.type);
      assert.equal(receipt.commandVariant, command.type);
      assert.isString(receipt.envelopeFingerprint);
      assert.equal(receipt.resultSequence, first.sequence);
    }),
  );

  it.effect("records rejected project commands with an immutable envelope", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const repository = yield* OrchestrationCommandReceiptRepository;
      const projectId = ProjectId.make("project:engine-rejected");
      yield* engine.dispatch(
        createProject(CommandId.make("command:engine-rejected-create"), projectId, "Original"),
      );

      const commandId = CommandId.make("command:engine-rejected");
      const command = createProject(commandId, projectId, "Duplicate");
      const first = yield* Effect.result(engine.dispatch(command));
      assert.equal(first._tag, "Failure");
      const retry = yield* Effect.result(engine.dispatch(command));
      assert.equal(retry._tag, "Failure");
      if (retry._tag === "Failure") assert.isTrue(isPreviouslyRejectedError(retry.failure));

      const changed = yield* Effect.result(
        engine.dispatch(createProject(commandId, projectId, "Different duplicate")),
      );
      assert.equal(changed._tag, "Failure");
      if (changed._tag === "Failure") assert.isTrue(isReceiptMismatchError(changed.failure));

      const receipt = Option.getOrThrow(yield* repository.getByCommandId({ commandId }));
      assert.equal(receipt.status, "rejected");
      assert.equal(receipt.commandVariant, command.type);
      assert.isString(receipt.envelopeFingerprint);
    }),
  );

  it.effect("fails closed when replaying a legacy project receipt without a fingerprint", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const repository = yield* OrchestrationCommandReceiptRepository;
      const commandId = CommandId.make("command:engine-legacy-receipt");
      const projectId = ProjectId.make("project:engine-legacy-receipt");
      const command = createProject(commandId, projectId, "Legacy");

      assert.isTrue(
        yield* repository.insertIfAbsent({
          commandId,
          aggregateKind: "project",
          aggregateId: projectId,
          commandType: "legacy",
          commandVariant: null,
          envelopeFingerprint: null,
          acceptedAt: "2026-01-01T00:00:00.000Z",
          resultSequence: 42,
          status: "accepted",
          error: null,
        }),
      );

      const replay = yield* Effect.result(engine.dispatch(command));
      assert.equal(replay._tag, "Failure");
      if (replay._tag === "Failure") {
        assert.isTrue(isReceiptMismatchError(replay.failure));
        if (isReceiptMismatchError(replay.failure)) {
          assert.equal(replay.failure.reason, "legacy-unverifiable");
        }
      }
    }),
  );
});
