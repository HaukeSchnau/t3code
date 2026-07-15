import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { OrchestrationCommandReceiptMismatchError } from "../Errors.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import {
  CommandPreprocessingCoordinator,
  type CommandPreprocessingStep,
  layer as CommandPreprocessingCoordinatorLive,
} from "./CommandPreprocessingCoordinator.ts";

const isReceiptMismatchError = Schema.is(OrchestrationCommandReceiptMismatchError);

const makePersistentFilename = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3-preprocessing-",
  });
  return path.join(directory, "state.sqlite");
});

const command = {
  type: "thread.turn.start",
  commandId: CommandId.make("cmd-bootstrap-restart"),
  threadId: ThreadId.make("thread-bootstrap-restart"),
  message: {
    messageId: MessageId.make("message-bootstrap-restart"),
    role: "user",
    text: "resume me",
    attachments: [],
  },
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5-codex",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  bootstrap: {
    createThread: {
      projectId: ProjectId.make("project-bootstrap-restart"),
      title: "Restart bootstrap",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    prepareWorkspace: {
      kind: "directory-copy",
      roots: [
        {
          projectId: ProjectId.make("project-bootstrap-restart"),
          sourcePath: "/tmp/bootstrap-source",
          role: "primary",
        },
      ],
      retentionPolicy: "explicit-delete",
    },
    runSetupScript: true,
  },
  createdAt: "2026-01-01T00:00:00.000Z",
} satisfies OrchestrationCommand;

const makePersistentLayer = (filename: string) => {
  const sqlite = NodeSqliteClient.layer({ filename });
  return CommandPreprocessingCoordinatorLive.pipe(Layer.provideMerge(sqlite));
};

const withFreshCoordinator = <A, E>(
  filename: string,
  effect: Effect.Effect<A, E, CommandPreprocessingCoordinator>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* runMigrations();
      return yield* effect;
    }).pipe(Effect.provide(makePersistentLayer(filename))),
  );

it.effect("resumes durable preprocessing checkpoints after coordinator restart", () =>
  Effect.gen(function* () {
    const filename = yield* makePersistentFilename;
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly completed: ReadonlyArray<CommandPreprocessingStep>;
      readonly expected: readonly [boolean, boolean, boolean, boolean, boolean];
    }> = [
      {
        name: "after attachment materialization",
        completed: ["deferred-preprocessing-completed"],
        expected: [true, false, false, false, false],
      },
      {
        name: "after thread creation and during workspace preparation",
        completed: ["deferred-preprocessing-completed", "thread-created"],
        expected: [true, true, false, false, false],
      },
      {
        name: "after workspace preparation",
        completed: ["deferred-preprocessing-completed", "thread-created", "workspace-prepared"],
        expected: [true, true, true, false, false],
      },
      {
        name: "after setup claim before terminal reconciliation",
        completed: [
          "deferred-preprocessing-completed",
          "thread-created",
          "workspace-prepared",
          "setup-claimed",
        ],
        expected: [true, true, true, true, false],
      },
      {
        name: "after setup",
        completed: [
          "deferred-preprocessing-completed",
          "thread-created",
          "workspace-prepared",
          "setup-claimed",
          "setup-completed",
        ],
        expected: [true, true, true, true, true],
      },
    ];

    for (const [index, checkpoint] of cases.entries()) {
      const checkpointCommand = {
        ...command,
        commandId: CommandId.make(`${command.commandId}-${index}`),
      };
      yield* withFreshCoordinator(
        filename,
        Effect.gen(function* () {
          const coordinator = yield* CommandPreprocessingCoordinator;
          yield* coordinator.claim(checkpointCommand);
          for (const step of checkpoint.completed) {
            yield* coordinator.markCompleted(checkpointCommand, step);
          }
        }),
      );

      const resumed = yield* withFreshCoordinator(
        filename,
        Effect.flatMap(CommandPreprocessingCoordinator, (coordinator) =>
          coordinator.claim(checkpointCommand),
        ),
      );
      assert.deepEqual(
        [
          resumed.deferredPreprocessingCompleted,
          resumed.threadCreated,
          resumed.workspacePrepared,
          resumed.setupClaimed,
          resumed.setupCompleted,
        ],
        checkpoint.expected,
        checkpoint.name,
      );
    }
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("fails closed after restart when a command id is reused with a changed envelope", () =>
  Effect.gen(function* () {
    const filename = yield* makePersistentFilename;
    yield* withFreshCoordinator(
      filename,
      Effect.flatMap(CommandPreprocessingCoordinator, (coordinator) =>
        coordinator.claim(command),
      ),
    );

    const result = yield* withFreshCoordinator(
      filename,
      Effect.flatMap(CommandPreprocessingCoordinator, (coordinator) =>
        coordinator.claim({
          ...command,
          message: { ...command.message, text: "changed" },
        }),
      ),
    ).pipe(Effect.result);
    assert.isTrue(result._tag === "Failure");
    if (result._tag === "Failure") {
      if (!isReceiptMismatchError(result.failure)) {
        return yield* Effect.die(result.failure);
      }
      assert.equal(result.failure.reason, "payload-mismatch");
    }
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("serializes consumers that share one persistence-scoped coordinator", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let active = 0;
    let maximumActive = 0;

    yield* Effect.scoped(Effect.gen(function* () {
      const coordinator = yield* CommandPreprocessingCoordinator;
      const criticalSection = Effect.acquireUseRelease(
        Effect.sync(() => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
        }),
        () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        () => Effect.sync(() => void (active -= 1)),
      );
      const first = yield* coordinator
        .withCommandLock(command.commandId, criticalSection)
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      const second = yield* coordinator
        .withCommandLock(command.commandId, criticalSection)
        .pipe(Effect.forkScoped);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
    }).pipe(Effect.provide(makePersistentLayer(":memory:"))));

    assert.equal(maximumActive, 1);
  }),
);
