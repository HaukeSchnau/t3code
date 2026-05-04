import { ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { VcsExternalDiffRepository, VcsTurnChangeRepository } from "../Services/VcsTurnChanges.ts";
import { VcsExternalDiffRepositoryLive, VcsTurnChangeRepositoryLive } from "./VcsTurnChanges.ts";

const SqliteMemory = NodeSqliteClient.layerMemory();
const layer = it.layer(
  Layer.mergeAll(
    SqliteMemory,
    VcsTurnChangeRepositoryLive.pipe(Layer.provide(SqliteMemory)),
    VcsExternalDiffRepositoryLive.pipe(Layer.provide(SqliteMemory)),
  ),
);

layer("Vcs turn/change metadata repositories", (it) => {
  it.effect("migrates tables and stores many-to-many JJ turn links", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const scopes = yield* VcsTurnChangeRepository;
      yield* runMigrations();

      const threadId = ThreadId.make("thread-vcs-links");
      const firstTurnId = TurnId.make("turn-1");
      const secondTurnId = TurnId.make("turn-2");
      const now = "2026-05-04T10:00:00.000Z";

      yield* scopes.upsertScope({
        repoRoot: "/repo",
        cwd: "/repo",
        vcs: "jj",
        threadId,
        turnId: firstTurnId,
        state: "running",
        startOperationId: "op1",
        endOperationId: null,
        boundaryChangeId: "change-a",
        fallbackChangeId: null,
        startedAt: now,
        completedAt: null,
        lastReconciledAt: now,
      });
      yield* scopes.upsertLink({
        repoRoot: "/repo",
        changeId: "change-a",
        threadId,
        turnId: firstTurnId,
        role: "modified",
        firstOperationId: "op1",
        lastOperationId: "op2",
        firstCommitId: "commit-a1",
        latestCommitId: "commit-a2",
        createdAt: now,
        updatedAt: now,
        prunedAt: null,
      });
      yield* scopes.upsertLink({
        repoRoot: "/repo",
        changeId: "change-a",
        threadId,
        turnId: secondTurnId,
        role: "modified",
        firstOperationId: "op3",
        lastOperationId: "op4",
        firstCommitId: "commit-a2",
        latestCommitId: "commit-a3",
        createdAt: now,
        updatedAt: now,
        prunedAt: null,
      });

      const linkedTurns = yield* scopes.listLinksByChangeIds({
        repoRoot: "/repo",
        changeIds: ["change-a"],
      });
      assert.deepStrictEqual(
        linkedTurns.map((link) => link.turnId),
        [firstTurnId, secondTurnId],
      );

      yield* scopes.markPruned({
        repoRoot: "/repo",
        changeIds: ["change-a"],
        prunedAt: "2026-05-04T10:01:00.000Z",
      });
      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM vcs_turn_change_links
        WHERE pruned_at IS NOT NULL
      `;
      assert.strictEqual(rows[0]?.count, 2);
    }),
  );

  it.effect("stores external provider diffs for non-JJ turns", () =>
    Effect.gen(function* () {
      const externalDiffs = yield* VcsExternalDiffRepository;
      yield* runMigrations();

      const threadId = ThreadId.make("thread-external-diff");
      const turnId = TurnId.make("turn-external");
      yield* externalDiffs.upsert({
        threadId,
        turnId,
        cwd: "/tmp/no-repo",
        scope: "non_repo",
        files: [{ path: "note.txt", insertions: 1, deletions: 0 }],
        diff: "diff --git a/note.txt b/note.txt",
        createdAt: "2026-05-04T10:00:00.000Z",
        updatedAt: "2026-05-04T10:00:00.000Z",
      });

      const rows = yield* externalDiffs.listByThread({ threadId, turnId });
      assert.strictEqual(rows.length, 1);
      assert.deepStrictEqual(rows[0]?.files, [{ path: "note.txt", insertions: 1, deletions: 0 }]);
    }),
  );
});
