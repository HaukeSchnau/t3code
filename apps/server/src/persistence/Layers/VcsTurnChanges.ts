import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  VcsExternalDiffRepository,
  VcsExternalTurnDiff,
  VcsTurnChangeLink,
  VcsTurnChangeRepository,
  VcsTurnScope,
  VcsTurnScopeState,
  type VcsExternalDiffRepositoryShape,
  type VcsTurnChangeRepositoryShape,
} from "../Services/VcsTurnChanges.ts";

const ScopeKey = Schema.Struct({
  repoRoot: Schema.String,
  threadId: Schema.String,
  turnId: Schema.String,
});

const ThreadKey = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.optional(Schema.String),
});

const ChangeIdKey = Schema.Struct({
  repoRoot: Schema.String,
  changeId: Schema.String,
});

const CompleteScopeInput = Schema.Struct({
  repoRoot: Schema.String,
  threadId: Schema.String,
  turnId: Schema.String,
  state: VcsTurnScopeState,
  endOperationId: Schema.NullOr(Schema.String),
  fallbackChangeId: Schema.NullOr(Schema.String),
  completedAt: Schema.String,
});

const MarkPrunedInput = Schema.Struct({
  repoRoot: Schema.String,
  changeId: Schema.String,
  prunedAt: Schema.String,
});

const ExternalThreadKey = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.optional(Schema.String),
});

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeVcsTurnChangeRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertScopeQuery = SqlSchema.void({
    Request: VcsTurnScope,
    execute: (scope) => sql`
      INSERT INTO vcs_turn_scopes (
        repo_root,
        cwd,
        vcs,
        thread_id,
        turn_id,
        state,
        start_operation_id,
        end_operation_id,
        boundary_change_id,
        fallback_change_id,
        started_at,
        completed_at,
        last_reconciled_at
      )
      VALUES (
        ${scope.repoRoot},
        ${scope.cwd},
        ${scope.vcs},
        ${scope.threadId},
        ${scope.turnId},
        ${scope.state},
        ${scope.startOperationId},
        ${scope.endOperationId},
        ${scope.boundaryChangeId},
        ${scope.fallbackChangeId},
        ${scope.startedAt},
        ${scope.completedAt},
        ${scope.lastReconciledAt}
      )
      ON CONFLICT (repo_root, thread_id, turn_id)
      DO UPDATE SET
        cwd = excluded.cwd,
        vcs = excluded.vcs,
        state = excluded.state,
        start_operation_id = coalesce(vcs_turn_scopes.start_operation_id, excluded.start_operation_id),
        end_operation_id = excluded.end_operation_id,
        boundary_change_id = coalesce(vcs_turn_scopes.boundary_change_id, excluded.boundary_change_id),
        fallback_change_id = coalesce(excluded.fallback_change_id, vcs_turn_scopes.fallback_change_id),
        completed_at = excluded.completed_at,
        last_reconciled_at = excluded.last_reconciled_at
    `,
  });

  const completeScopeQuery = SqlSchema.void({
    Request: CompleteScopeInput,
    execute: (input) => sql`
      UPDATE vcs_turn_scopes
      SET state = ${input.state},
          end_operation_id = ${input.endOperationId},
          fallback_change_id = ${input.fallbackChangeId},
          completed_at = ${input.completedAt},
          last_reconciled_at = ${input.completedAt}
      WHERE repo_root = ${input.repoRoot}
        AND thread_id = ${input.threadId}
        AND turn_id = ${input.turnId}
    `,
  });

  const getScopeQuery = SqlSchema.findOneOption({
    Request: ScopeKey,
    Result: VcsTurnScope,
    execute: (input) => sql`
      SELECT
        repo_root AS "repoRoot",
        cwd,
        vcs,
        thread_id AS "threadId",
        turn_id AS "turnId",
        state,
        start_operation_id AS "startOperationId",
        end_operation_id AS "endOperationId",
        boundary_change_id AS "boundaryChangeId",
        fallback_change_id AS "fallbackChangeId",
        started_at AS "startedAt",
        completed_at AS "completedAt",
        last_reconciled_at AS "lastReconciledAt"
      FROM vcs_turn_scopes
      WHERE repo_root = ${input.repoRoot}
        AND thread_id = ${input.threadId}
        AND turn_id = ${input.turnId}
    `,
  });

  const listScopesByThreadQuery = SqlSchema.findAll({
    Request: Schema.Struct({ threadId: Schema.String }),
    Result: VcsTurnScope,
    execute: (input) => sql`
      SELECT
        repo_root AS "repoRoot",
        cwd,
        vcs,
        thread_id AS "threadId",
        turn_id AS "turnId",
        state,
        start_operation_id AS "startOperationId",
        end_operation_id AS "endOperationId",
        boundary_change_id AS "boundaryChangeId",
        fallback_change_id AS "fallbackChangeId",
        started_at AS "startedAt",
        completed_at AS "completedAt",
        last_reconciled_at AS "lastReconciledAt"
      FROM vcs_turn_scopes
      WHERE thread_id = ${input.threadId}
      ORDER BY started_at ASC
    `,
  });

  const upsertLinkQuery = SqlSchema.void({
    Request: VcsTurnChangeLink,
    execute: (link) => sql`
      INSERT INTO vcs_turn_change_links (
        repo_root,
        change_id,
        thread_id,
        turn_id,
        role,
        first_operation_id,
        last_operation_id,
        first_commit_id,
        latest_commit_id,
        created_at,
        updated_at,
        pruned_at
      )
      VALUES (
        ${link.repoRoot},
        ${link.changeId},
        ${link.threadId},
        ${link.turnId},
        ${link.role},
        ${link.firstOperationId},
        ${link.lastOperationId},
        ${link.firstCommitId},
        ${link.latestCommitId},
        ${link.createdAt},
        ${link.updatedAt},
        ${link.prunedAt}
      )
      ON CONFLICT (repo_root, change_id, thread_id, turn_id)
      DO UPDATE SET
        role = CASE
          WHEN vcs_turn_change_links.role = 'guard' AND excluded.role <> 'guard' THEN excluded.role
          WHEN vcs_turn_change_links.role = 'fallback' THEN vcs_turn_change_links.role
          ELSE excluded.role
        END,
        last_operation_id = excluded.last_operation_id,
        latest_commit_id = excluded.latest_commit_id,
        updated_at = excluded.updated_at,
        pruned_at = excluded.pruned_at
    `,
  });

  const listLinksByChangeIdQuery = SqlSchema.findAll({
    Request: ChangeIdKey,
    Result: VcsTurnChangeLink,
    execute: (input) => sql`
      SELECT
        repo_root AS "repoRoot",
        change_id AS "changeId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        role,
        first_operation_id AS "firstOperationId",
        last_operation_id AS "lastOperationId",
        first_commit_id AS "firstCommitId",
        latest_commit_id AS "latestCommitId",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        pruned_at AS "prunedAt"
      FROM vcs_turn_change_links
      WHERE repo_root = ${input.repoRoot}
        AND change_id = ${input.changeId}
      ORDER BY created_at ASC
    `,
  });

  const listLinksByThreadQuery = SqlSchema.findAll({
    Request: ThreadKey,
    Result: VcsTurnChangeLink,
    execute: (input) =>
      input.turnId
        ? sql`
            SELECT
              repo_root AS "repoRoot",
              change_id AS "changeId",
              thread_id AS "threadId",
              turn_id AS "turnId",
              role,
              first_operation_id AS "firstOperationId",
              last_operation_id AS "lastOperationId",
              first_commit_id AS "firstCommitId",
              latest_commit_id AS "latestCommitId",
              created_at AS "createdAt",
              updated_at AS "updatedAt",
              pruned_at AS "prunedAt"
            FROM vcs_turn_change_links
            WHERE thread_id = ${input.threadId}
              AND turn_id = ${input.turnId}
            ORDER BY created_at ASC
          `
        : sql`
            SELECT
              repo_root AS "repoRoot",
              change_id AS "changeId",
              thread_id AS "threadId",
              turn_id AS "turnId",
              role,
              first_operation_id AS "firstOperationId",
              last_operation_id AS "lastOperationId",
              first_commit_id AS "firstCommitId",
              latest_commit_id AS "latestCommitId",
              created_at AS "createdAt",
              updated_at AS "updatedAt",
              pruned_at AS "prunedAt"
            FROM vcs_turn_change_links
            WHERE thread_id = ${input.threadId}
            ORDER BY created_at ASC
          `,
  });

  const markPrunedQuery = SqlSchema.void({
    Request: MarkPrunedInput,
    execute: (input) => sql`
      UPDATE vcs_turn_change_links
      SET pruned_at = ${input.prunedAt},
          updated_at = ${input.prunedAt}
      WHERE repo_root = ${input.repoRoot}
        AND change_id = ${input.changeId}
    `,
  });

  const mapRepositoryError = (sqlOperation: string, decodeOperation: string) =>
    Effect.mapError(toPersistenceSqlOrDecodeError(sqlOperation, decodeOperation));

  const upsertScope: VcsTurnChangeRepositoryShape["upsertScope"] = (scope) =>
    upsertScopeQuery(scope).pipe(
      mapRepositoryError("VcsTurnChangeRepository.upsertScope", "upsertScope"),
    );

  const completeScope: VcsTurnChangeRepositoryShape["completeScope"] = (input) =>
    completeScopeQuery(input).pipe(
      mapRepositoryError("VcsTurnChangeRepository.completeScope", "completeScope"),
    );

  const getScope: VcsTurnChangeRepositoryShape["getScope"] = (input) =>
    getScopeQuery(input).pipe(
      mapRepositoryError("VcsTurnChangeRepository.getScope", "getScope"),
      Effect.map((scope) => Option.getOrNull(scope)),
    );

  const listScopesByThread: VcsTurnChangeRepositoryShape["listScopesByThread"] = (input) =>
    listScopesByThreadQuery(input).pipe(
      mapRepositoryError("VcsTurnChangeRepository.listScopesByThread", "listScopesByThread"),
    );

  const upsertLink: VcsTurnChangeRepositoryShape["upsertLink"] = (link) =>
    upsertLinkQuery(link).pipe(
      mapRepositoryError("VcsTurnChangeRepository.upsertLink", "upsertLink"),
    );

  const listLinksByChangeIds: VcsTurnChangeRepositoryShape["listLinksByChangeIds"] = (input) =>
    Effect.forEach(
      input.changeIds,
      (changeId) => listLinksByChangeIdQuery({ repoRoot: input.repoRoot, changeId }),
      { concurrency: 4 },
    ).pipe(
      Effect.map((rows) => rows.flat()),
      mapRepositoryError("VcsTurnChangeRepository.listLinksByChangeIds", "listLinksByChangeIds"),
    );

  const listLinksByThread: VcsTurnChangeRepositoryShape["listLinksByThread"] = (input) =>
    listLinksByThreadQuery(input).pipe(
      mapRepositoryError("VcsTurnChangeRepository.listLinksByThread", "listLinksByThread"),
    );

  const markPruned: VcsTurnChangeRepositoryShape["markPruned"] = (input) =>
    Effect.forEach(
      input.changeIds,
      (changeId) =>
        markPrunedQuery({ repoRoot: input.repoRoot, changeId, prunedAt: input.prunedAt }),
      { concurrency: 4, discard: true },
    ).pipe(mapRepositoryError("VcsTurnChangeRepository.markPruned", "markPruned"));

  return {
    upsertScope,
    completeScope,
    getScope,
    listScopesByThread,
    upsertLink,
    listLinksByChangeIds,
    listLinksByThread,
    markPruned,
  } satisfies VcsTurnChangeRepositoryShape;
});

const makeVcsExternalDiffRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertQuery = SqlSchema.void({
    Request: VcsExternalTurnDiff,
    execute: (diff) => sql`
      INSERT INTO vcs_external_turn_diffs (
        thread_id,
        turn_id,
        cwd,
        scope,
        unified_diff,
        files_json,
        created_at,
        updated_at
      )
      VALUES (
        ${diff.threadId},
        ${diff.turnId},
        ${diff.cwd},
        ${diff.scope},
        ${diff.diff},
        ${JSON.stringify(diff.files)},
        ${diff.createdAt},
        ${diff.updatedAt}
      )
      ON CONFLICT (thread_id, turn_id, cwd, scope)
      DO UPDATE SET
        unified_diff = excluded.unified_diff,
        files_json = excluded.files_json,
        updated_at = excluded.updated_at
    `,
  });

  const RawExternalTurnDiff = Schema.Struct({
    threadId: Schema.String,
    turnId: Schema.String,
    cwd: Schema.String,
    scope: VcsExternalTurnDiff.fields.scope,
    diff: Schema.String,
    files: Schema.String,
    createdAt: Schema.String,
    updatedAt: Schema.String,
  });

  const listByThreadQuery = SqlSchema.findAll({
    Request: ExternalThreadKey,
    Result: RawExternalTurnDiff,
    execute: (input) =>
      input.turnId
        ? sql`
            SELECT
              thread_id AS "threadId",
              turn_id AS "turnId",
              cwd,
              scope,
              unified_diff AS "diff",
              files_json AS "files",
              created_at AS "createdAt",
              updated_at AS "updatedAt"
            FROM vcs_external_turn_diffs
            WHERE thread_id = ${input.threadId}
              AND turn_id = ${input.turnId}
            ORDER BY updated_at ASC
          `
        : sql`
            SELECT
              thread_id AS "threadId",
              turn_id AS "turnId",
              cwd,
              scope,
              unified_diff AS "diff",
              files_json AS "files",
              created_at AS "createdAt",
              updated_at AS "updatedAt"
            FROM vcs_external_turn_diffs
            WHERE thread_id = ${input.threadId}
            ORDER BY updated_at ASC
          `,
  });

  const decodeExternalDiff = (row: typeof RawExternalTurnDiff.Type) =>
    Schema.decodeUnknownEffect(VcsExternalTurnDiff)({
      ...row,
      files: JSON.parse(row.files),
    });

  const mapRepositoryError = (sqlOperation: string, decodeOperation: string) =>
    Effect.mapError(toPersistenceSqlOrDecodeError(sqlOperation, decodeOperation));

  const upsert: VcsExternalDiffRepositoryShape["upsert"] = (diff) =>
    upsertQuery(diff).pipe(mapRepositoryError("VcsExternalDiffRepository.upsert", "upsert"));

  const listByThread: VcsExternalDiffRepositoryShape["listByThread"] = (input) =>
    listByThreadQuery(input).pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, decodeExternalDiff)),
      mapRepositoryError("VcsExternalDiffRepository.listByThread", "listByThread"),
    );

  return { upsert, listByThread } satisfies VcsExternalDiffRepositoryShape;
});

export const VcsTurnChangeRepositoryLive = Layer.effect(
  VcsTurnChangeRepository,
  makeVcsTurnChangeRepository,
);

export const VcsExternalDiffRepositoryLive = Layer.effect(
  VcsExternalDiffRepository,
  makeVcsExternalDiffRepository,
);
