import { assert, it } from "@effect/vitest";
import { CommandId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { PersistenceSqlError } from "../Errors.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "./OrchestrationCommandReceipts.ts";
import { OrchestrationCommandReceiptRepository } from "../Services/OrchestrationCommandReceipts.ts";

const isPersistenceSqlError = Schema.is(PersistenceSqlError);

const layer = it.layer(
  OrchestrationCommandReceiptRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("OrchestrationCommandReceiptRepository", (it) => {
  it.effect("keeps the provisional winner immutable when finalization identity differs", () =>
    Effect.gen(function* () {
      const repository = yield* OrchestrationCommandReceiptRepository;
      const commandId = CommandId.make("command:receipt-identity");
      const projectId = ProjectId.make("project:receipt-identity");
      const provisional = {
        commandId,
        aggregateKind: "project" as const,
        aggregateId: projectId,
        commandType: "project.create",
        commandVariant: "project.create",
        envelopeFingerprint: "fingerprint:original",
        acceptedAt: "2026-01-01T00:00:00.000Z",
        resultSequence: 0,
        status: "accepted" as const,
        error: null,
      };

      assert.isTrue(yield* repository.insertIfAbsent(provisional));

      const changedBeforeFinalization = yield* Effect.result(
        repository.upsert({
          ...provisional,
          envelopeFingerprint: "fingerprint:changed",
          resultSequence: 4,
        }),
      );
      assert.equal(changedBeforeFinalization._tag, "Failure");
      if (changedBeforeFinalization._tag === "Failure") {
        assert.isTrue(isPersistenceSqlError(changedBeforeFinalization.failure));
      }

      const afterConflict = yield* repository.getByCommandId({ commandId });
      assert.deepStrictEqual(Option.getOrThrow(afterConflict), provisional);

      yield* repository.upsert({ ...provisional, resultSequence: 4 });

      const changedAfterFinalization = yield* Effect.result(
        repository.upsert({
          ...provisional,
          envelopeFingerprint: "fingerprint:changed",
          resultSequence: 5,
        }),
      );
      assert.equal(changedAfterFinalization._tag, "Failure");
      if (changedAfterFinalization._tag === "Failure") {
        assert.isTrue(isPersistenceSqlError(changedAfterFinalization.failure));
      }

      const winner = Option.getOrThrow(yield* repository.getByCommandId({ commandId }));
      assert.equal(winner.envelopeFingerprint, provisional.envelopeFingerprint);
      assert.equal(winner.resultSequence, 4);
    }),
  );

  it.effect("round-trips provider aggregate identities used by legacy receipts", () =>
    Effect.gen(function* () {
      const repository = yield* OrchestrationCommandReceiptRepository;
      const receipt = {
        commandId: CommandId.make("command:provider-receipt"),
        aggregateKind: "provider" as const,
        aggregateId: ProviderInstanceId.make("codex-custom"),
        commandType: "provider.usage-limits.update",
        commandVariant: "provider.usage-limits.update",
        envelopeFingerprint: "fingerprint:provider",
        acceptedAt: "2026-01-01T00:00:00.000Z",
        resultSequence: 17,
        status: "accepted" as const,
        error: null,
      };

      assert.isTrue(yield* repository.insertIfAbsent(receipt));
      assert.deepStrictEqual(
        Option.getOrThrow(yield* repository.getByCommandId({ commandId: receipt.commandId })),
        receipt,
      );
    }),
  );
});
