import { assert, it } from "@effect/vitest";
import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationCommandReceiptRepositoryLive } from "../Layers/OrchestrationCommandReceipts.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { OrchestrationCommandReceiptRepository } from "../Services/OrchestrationCommandReceipts.ts";

const sqliteLayer = NodeSqliteClient.layerMemory();
const layer = it.layer(
  OrchestrationCommandReceiptRepositoryLive.pipe(Layer.provideMerge(sqliteLayer)),
);

layer("038_OrchestrationCommandReceiptEnvelopes", (it) => {
  it.effect("preserves legacy receipts as explicitly unverifiable rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const receiptRepository = yield* OrchestrationCommandReceiptRepository;

      yield* runMigrations({ toMigrationInclusive: 37 });
      yield* sql`
        INSERT INTO orchestration_command_receipts (
          command_id,
          aggregate_kind,
          aggregate_id,
          accepted_at,
          result_sequence,
          status,
          error
        )
        VALUES (
          'cmd-legacy-receipt',
          'thread',
          'thread-legacy-receipt',
          '2026-01-01T00:00:00.000Z',
          42,
          'accepted',
          NULL
        )
      `;

      // The receipt repository reads command_type, which was added by the
      // application-event migration after the envelope columns. Run through
      // that schema boundary while keeping the legacy row itself pre-038.
      yield* runMigrations({ toMigrationInclusive: 76 });

      const receipt = yield* receiptRepository.getByCommandId({
        commandId: CommandId.make("cmd-legacy-receipt"),
      });
      assert.deepStrictEqual(Option.getOrThrow(receipt), {
        commandId: CommandId.make("cmd-legacy-receipt"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-legacy-receipt"),
        commandType: "legacy",
        commandVariant: null,
        envelopeFingerprint: null,
        acceptedAt: "2026-01-01T00:00:00.000Z",
        resultSequence: 42,
        status: "accepted",
        error: null,
      });
    }),
  );
});
