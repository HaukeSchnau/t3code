import {
  CommandId,
  type OrchestrationCommand,
  type ProjectId,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceSqlError, toPersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationCommandReceiptMismatchError } from "../Errors.ts";
import { commandEnvelopeFingerprint } from "../CommandEnvelope.ts";

export type CommandPreprocessingStep =
  | "deferred-preprocessing-completed"
  | "thread-created"
  | "workspace-prepared"
  | "setup-completed";

export interface SetupExecutionIdentity {
  readonly executionKey: string;
  readonly scriptDigest: string;
}

export type CommandPreprocessingSetupState =
  | { readonly status: "pending" }
  | { readonly status: "claimed"; readonly execution: SetupExecutionIdentity }
  | {
      readonly status: "completed";
      readonly execution: SetupExecutionIdentity | null;
    };

export interface CommandPreprocessingProgress {
  readonly commandId: CommandId;
  readonly aggregateKind: "project" | "thread" | "provider";
  readonly aggregateId: ProjectId | ThreadId | ProviderInstanceId;
  readonly commandVariant: OrchestrationCommand["type"];
  readonly envelopeFingerprint: string;
  readonly deferredPreprocessingCompleted: boolean;
  readonly threadCreated: boolean;
  readonly workspacePrepared: boolean;
  readonly setup: CommandPreprocessingSetupState;
}

interface ProgressRow {
  readonly commandId: CommandId;
  readonly aggregateKind: CommandPreprocessingProgress["aggregateKind"];
  readonly aggregateId: CommandPreprocessingProgress["aggregateId"];
  readonly commandVariant: OrchestrationCommand["type"];
  readonly envelopeFingerprint: string;
  readonly deferredPreprocessingCompleted: number;
  readonly threadCreated: number;
  readonly workspacePrepared: number;
  readonly setupClaimed: number;
  readonly setupCompleted: number;
  readonly setupExecutionKey: string | null;
  readonly setupScriptDigest: string | null;
}

type CommandPreprocessingError = PersistenceSqlError | OrchestrationCommandReceiptMismatchError;

function aggregateRef(command: OrchestrationCommand): {
  readonly aggregateKind: CommandPreprocessingProgress["aggregateKind"];
  readonly aggregateId: CommandPreprocessingProgress["aggregateId"];
} {
  switch (command.type) {
    case "project.create":
    case "project.meta.update":
    case "project.delete":
      return { aggregateKind: "project", aggregateId: command.projectId };
    case "provider.usage-limits.update":
      return { aggregateKind: "provider", aggregateId: command.providerInstanceId };
    default:
      return { aggregateKind: "thread", aggregateId: command.threadId };
  }
}

function toProgress(
  row: ProgressRow,
): Effect.Effect<CommandPreprocessingProgress, PersistenceSqlError> {
  const setupClaimed = row.setupClaimed === 1;
  const setupCompleted = row.setupCompleted === 1;
  const hasExecutionKey = row.setupExecutionKey !== null;
  const hasScriptDigest = row.setupScriptDigest !== null;
  if (hasExecutionKey !== hasScriptDigest || (setupClaimed && !hasExecutionKey)) {
    return Effect.fail(
      new PersistenceSqlError({
        operation: "CommandPreprocessingCoordinator.readProgress",
        detail: `Preprocessing progress '${row.commandId}' has an invalid durable setup identity.`,
      }),
    );
  }
  const execution =
    row.setupExecutionKey !== null && row.setupScriptDigest !== null
      ? { executionKey: row.setupExecutionKey, scriptDigest: row.setupScriptDigest }
      : null;
  const setup: CommandPreprocessingSetupState = setupCompleted
    ? { status: "completed", execution }
    : setupClaimed && execution
      ? { status: "claimed", execution }
      : { status: "pending" };
  return Effect.succeed({
    ...row,
    deferredPreprocessingCompleted: row.deferredPreprocessingCompleted === 1,
    threadCreated: row.threadCreated === 1,
    workspacePrepared: row.workspacePrepared === 1,
    setup,
  });
}

export class CommandPreprocessingCoordinator extends Context.Service<
  CommandPreprocessingCoordinator,
  {
    readonly withCommandLock: <A, E, R>(
      commandId: CommandId,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    readonly claim: (
      command: OrchestrationCommand,
    ) => Effect.Effect<CommandPreprocessingProgress, CommandPreprocessingError>;
    readonly markCompleted: (
      command: OrchestrationCommand,
      step: CommandPreprocessingStep,
    ) => Effect.Effect<CommandPreprocessingProgress, CommandPreprocessingError>;
    readonly claimSetup: (
      command: OrchestrationCommand,
      execution: SetupExecutionIdentity,
    ) => Effect.Effect<CommandPreprocessingProgress, CommandPreprocessingError>;
  }
>()("t3/orchestration/Services/CommandPreprocessingCoordinator") {}

export function preprocessingCommandId(command: OrchestrationCommand, phase: string): CommandId {
  const fingerprint = commandEnvelopeFingerprint(command).slice(0, 16);
  return CommandId.make(`preprocess:${command.commandId}:${fingerprint}:${phase}`);
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const locks = new Map<string, { readonly semaphore: Semaphore.Semaphore; users: number }>();
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const readProgress = (commandId: CommandId) =>
    sql<ProgressRow>`
      SELECT
        command_id AS "commandId",
        aggregate_kind AS "aggregateKind",
        aggregate_id AS "aggregateId",
        command_variant AS "commandVariant",
        envelope_fingerprint AS "envelopeFingerprint",
        deferred_preprocessing_completed AS "deferredPreprocessingCompleted",
        thread_created AS "threadCreated",
        workspace_prepared AS "workspacePrepared",
        setup_claimed AS "setupClaimed",
        setup_completed AS "setupCompleted",
        setup_execution_key AS "setupExecutionKey",
        setup_script_digest AS "setupScriptDigest"
      FROM orchestration_command_preprocessing
      WHERE command_id = ${commandId}
    `.pipe(
      Effect.mapError(toPersistenceSqlError("CommandPreprocessingCoordinator.readProgress")),
      Effect.flatMap((rows) =>
        rows[0]
          ? toProgress(rows[0])
          : Effect.fail(
              new PersistenceSqlError({
                operation: "CommandPreprocessingCoordinator.readProgress",
                detail: `Preprocessing progress '${commandId}' disappeared after its durable claim.`,
              }),
            ),
      ),
    );

  const validateProgress = (
    command: OrchestrationCommand,
    progress: CommandPreprocessingProgress,
  ) => {
    const aggregate = aggregateRef(command);
    const fingerprint = commandEnvelopeFingerprint(command);
    if (
      progress.aggregateKind !== aggregate.aggregateKind ||
      progress.aggregateId !== aggregate.aggregateId
    ) {
      return Effect.fail(
        new OrchestrationCommandReceiptMismatchError({
          commandId: command.commandId,
          reason: "aggregate-mismatch",
          detail: "Durable preprocessing progress belongs to a different aggregate.",
        }),
      );
    }
    if (progress.commandVariant !== command.type) {
      return Effect.fail(
        new OrchestrationCommandReceiptMismatchError({
          commandId: command.commandId,
          reason: "variant-mismatch",
          detail: "Durable preprocessing progress belongs to a different command variant.",
        }),
      );
    }
    if (progress.envelopeFingerprint !== fingerprint) {
      return Effect.fail(
        new OrchestrationCommandReceiptMismatchError({
          commandId: command.commandId,
          reason: "payload-mismatch",
          detail: "The canonical command envelope differs from durable preprocessing progress.",
        }),
      );
    }
    return Effect.succeed(progress);
  };

  const claim: CommandPreprocessingCoordinator["Service"]["claim"] = (command) => {
    const aggregate = aggregateRef(command);
    const fingerprint = commandEnvelopeFingerprint(command);
    return Effect.gen(function* () {
      const timestamp = yield* nowIso;
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
          ${command.commandId},
          ${aggregate.aggregateKind},
          ${aggregate.aggregateId},
          ${command.type},
          ${fingerprint},
          ${timestamp},
          ${timestamp}
        )
        ON CONFLICT(command_id) DO NOTHING
      `.pipe(Effect.mapError(toPersistenceSqlError("CommandPreprocessingCoordinator.claim")));
      return yield* readProgress(command.commandId).pipe(
        Effect.flatMap((progress) => validateProgress(command, progress)),
      );
    });
  };

  const markCompleted: CommandPreprocessingCoordinator["Service"]["markCompleted"] = (
    command,
    step,
  ) =>
    Effect.gen(function* () {
      yield* claim(command);
      const timestamp = yield* nowIso;
      const update = (() => {
        switch (step) {
          case "deferred-preprocessing-completed":
            return sql`UPDATE orchestration_command_preprocessing SET deferred_preprocessing_completed = 1, updated_at = ${timestamp} WHERE command_id = ${command.commandId}`;
          case "thread-created":
            return sql`UPDATE orchestration_command_preprocessing SET thread_created = 1, updated_at = ${timestamp} WHERE command_id = ${command.commandId}`;
          case "workspace-prepared":
            return sql`UPDATE orchestration_command_preprocessing SET workspace_prepared = 1, updated_at = ${timestamp} WHERE command_id = ${command.commandId}`;
          case "setup-completed":
            return sql`UPDATE orchestration_command_preprocessing SET setup_completed = 1, updated_at = ${timestamp} WHERE command_id = ${command.commandId}`;
        }
      })();
      yield* update.pipe(
        Effect.mapError(toPersistenceSqlError("CommandPreprocessingCoordinator.markCompleted")),
      );
      return yield* readProgress(command.commandId).pipe(
        Effect.flatMap((progress) => validateProgress(command, progress)),
      );
    });

  const claimSetup: CommandPreprocessingCoordinator["Service"]["claimSetup"] = (
    command,
    execution,
  ) =>
    Effect.gen(function* () {
      const progress = yield* claim(command);
      if (progress.setup.status !== "pending") {
        const durableExecution = progress.setup.execution;
        if (
          durableExecution?.executionKey !== execution.executionKey ||
          durableExecution.scriptDigest !== execution.scriptDigest
        ) {
          return yield* new OrchestrationCommandReceiptMismatchError({
            commandId: command.commandId,
            reason: "payload-mismatch",
            detail: "The setup execution identity differs from the durable preprocessing claim.",
          });
        }
        return progress;
      }
      const timestamp = yield* nowIso;
      yield* sql`
        UPDATE orchestration_command_preprocessing
        SET
          setup_claimed = 1,
          setup_execution_key = ${execution.executionKey},
          setup_script_digest = ${execution.scriptDigest},
          updated_at = ${timestamp}
        WHERE command_id = ${command.commandId} AND setup_claimed = 0 AND setup_completed = 0
      `.pipe(Effect.mapError(toPersistenceSqlError("CommandPreprocessingCoordinator.claimSetup")));
      return yield* readProgress(command.commandId).pipe(
        Effect.flatMap((next) => validateProgress(command, next)),
        Effect.flatMap((next) => {
          const durableExecution =
            next.setup.status === "pending" ? null : next.setup.execution;
          return durableExecution !== null &&
            durableExecution?.executionKey === execution.executionKey &&
            durableExecution.scriptDigest === execution.scriptDigest
            ? Effect.succeed(next)
            : Effect.fail(
                new OrchestrationCommandReceiptMismatchError({
                  commandId: command.commandId,
                  reason: "payload-mismatch",
                  detail: "The setup execution identity differs from the durable preprocessing claim.",
                }),
              );
        }),
      );
    });

  const withCommandLock: CommandPreprocessingCoordinator["Service"]["withCommandLock"] = (
    commandId,
    effect,
  ) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const existing = locks.get(commandId);
        if (existing) {
          existing.users += 1;
          return existing;
        }
        const created = { semaphore: Semaphore.makeUnsafe(1), users: 1 };
        locks.set(commandId, created);
        return created;
      }),
      ({ semaphore }) => semaphore.withPermits(1)(effect),
      (entry) =>
        Effect.sync(() => {
          entry.users -= 1;
          if (entry.users === 0) {
            locks.delete(commandId);
          }
        }),
    );

  return CommandPreprocessingCoordinator.of({ withCommandLock, claim, markCompleted, claimSetup });
});

export const layer = Layer.effect(CommandPreprocessingCoordinator, make);
