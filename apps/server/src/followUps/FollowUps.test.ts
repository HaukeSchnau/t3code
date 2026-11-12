import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, type FollowUpActor, FollowUpId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as FollowUps from "./FollowUps.ts";

const agent: FollowUpActor = {
  kind: "agent",
  thread: { environmentId: EnvironmentId.make("env:home"), threadId: ThreadId.make("thread:a") },
};

/** The service with its due scan captured instead of scheduled, so a test runs it on demand. */
const withFollowUps = <A, E>(
  body: (input: {
    readonly followUps: FollowUps.FollowUps["Service"];
    readonly runDueScan: Effect.Effect<void>;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const scan = yield* Ref.make<Effect.Effect<void> | null>(null);
    const scheduler = Layer.succeed(Scheduler.Scheduler, {
      register: <E, R>(_name: string, work: Effect.Effect<void, E, R>) =>
        Effect.gen(function* () {
          const context = yield* Effect.context<R>();
          yield* Ref.set(scan, work.pipe(Effect.provideContext(context), Effect.ignore));
        }),
    });
    return yield* Effect.gen(function* () {
      const followUps = yield* FollowUps.FollowUps;
      const runDueScan = Ref.get(scan).pipe(Effect.flatMap((work) => work ?? Effect.void));
      return yield* body({ followUps, runDueScan });
    }).pipe(
      Effect.provide(
        FollowUps.layer.pipe(
          Layer.provide(scheduler),
          Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          Layer.provide(SqlitePersistence.layerMemory),
        ),
      ),
    );
  });

describe("FollowUps", () => {
  it.effect("records every change and keeps closed follow-ups out of the open list", () =>
    withFollowUps(({ followUps }) =>
      Effect.gen(function* () {
        const created = yield* followUps.save(
          {
            title: "Rotate the pasted API key",
            body: "It sits in plain text.",
            tags: ["Security", "security"],
          },
          agent,
        );
        assert.deepEqual(created.tags, ["Security"]);
        assert.isNull(created.closedAt);

        const done = yield* followUps.save(
          { id: created.id, status: "done", result: "Rotated on Nov 13." },
          agent,
        );
        assert.isNotNull(done.closedAt);

        const open = yield* followUps.snapshot({});
        assert.deepEqual(open.followUps, []);
        const all = yield* followUps.snapshot({ includeClosed: true });
        assert.deepEqual(
          all.followUps.map((followUp) => followUp.id),
          [created.id],
        );

        const history = yield* followUps.history(created.id);
        assert.deepEqual(
          history.map((change) => change.summary),
          ["created", "open → done; result: Rotated on Nov 13."],
        );
        // Saving the same values again changes nothing and logs nothing.
        yield* followUps.save({ id: created.id, result: "Rotated on Nov 13." }, agent);
        assert.lengthOf(yield* followUps.history(created.id), 2);

        // Another thread taking it over is a change, not a repeat.
        const thread = (threadId: string) => ({
          environmentId: EnvironmentId.make("env:home"),
          threadId: ThreadId.make(threadId),
        });
        yield* followUps.save(
          { id: created.id, status: "picked_up", pickedUpThread: thread("thread:b") },
          agent,
        );
        const takenOver = yield* followUps.save(
          { id: created.id, status: "picked_up", pickedUpThread: thread("thread:c") },
          agent,
        );
        assert.deepEqual(takenOver.pickedUpThread, thread("thread:c"));
        assert.deepEqual(
          (yield* followUps.history(created.id)).slice(2).map((change) => change.summary),
          // Reopening drops the old result.
          ["done → picked up in thread thread:b; changed result", "picked up in thread thread:c"],
        );
      }),
    ),
  );

  it.effect("holds types and fields to the registry", () =>
    withFollowUps(({ followUps }) =>
      Effect.gen(function* () {
        const unknownType = yield* followUps
          .save({ title: "CA provisioners", type: "risk" }, agent)
          .pipe(Effect.flip);
        assert.include(unknownType.message, 'no follow-up type "risk"');
        const untypedFields = yield* followUps
          .save({ title: "CA provisioners", fields: { severity: "high" } }, agent)
          .pipe(Effect.flip);
        assert.include(untypedFields.message, "Fields belong to a type");

        // A type and a follow-up land together or not at all.
        const halfSaved = yield* followUps
          .apply(
            {
              defineType: { name: "idea", description: "Work worth doing.", fields: [] },
              save: { type: "idea" },
            },
            agent,
          )
          .pipe(Effect.flip);
        assert.include(halfSaved.message, "needs a title");
        assert.deepEqual((yield* followUps.snapshot({})).types, []);

        yield* followUps.apply(
          {
            defineType: {
              name: "risk",
              description: "Something that can go wrong.",
              fields: [{ name: "severity", description: "low, medium or high" }],
            },
          },
          agent,
        );
        const risk = yield* followUps.save(
          { title: "CA provisioners", type: "risk", fields: { severity: "high" } },
          agent,
        );
        const unknownField = yield* followUps
          .save({ id: risk.id, fields: { owner: "Hauke" } }, agent)
          .pipe(Effect.flip);
        assert.include(unknownField.message, "has no field owner");

        const dropInUse = yield* followUps
          .apply({ defineType: { name: "risk", description: "Renamed.", fields: [] } }, agent)
          .pipe(Effect.flip);
        assert.include(dropInUse.message, `${risk.id} still use the field severity`);
      }),
    ),
  );

  it.effect("merges only into a follow-up that exists", () =>
    withFollowUps(({ followUps }) =>
      Effect.gen(function* () {
        const kept = yield* followUps.save({ title: "Admission control on srv-2" }, agent);
        const duplicate = yield* followUps.save({ title: "Limit load on srv-2" }, agent);
        const missing = yield* followUps
          .save(
            { id: duplicate.id, status: "merged", mergedInto: FollowUpId.make("fu-missing") },
            agent,
          )
          .pipe(Effect.flip);
        assert.include(missing.message, "There is no follow-up fu-missing");
        const merged = yield* followUps.save(
          { id: duplicate.id, status: "merged", mergedInto: kept.id },
          agent,
        );
        assert.strictEqual(merged.mergedInto, kept.id);
        assert.deepEqual(
          (yield* followUps.history(duplicate.id)).at(-1)?.summary,
          `merged into ${kept.id}`,
        );
        const third = yield* followUps.save({ title: "srv-2 load" }, agent);
        const remerged = yield* followUps.save(
          { id: duplicate.id, status: "merged", mergedInto: third.id },
          agent,
        );
        assert.strictEqual(remerged.mergedInto, third.id);
      }),
    ),
  );

  it.effect(
    "returns a dated follow-up to the inbox once its date arrives, and a later date takes it back",
    () =>
      withFollowUps(({ followUps, runDueScan }) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.UTC(2026, 10, 12, 12));
          const followUp = yield* followUps.save(
            { title: "Prove changes on the path Hauke uses", dueAt: "2026-12-01T08:00:00+01:00" },
            agent,
          );
          assert.strictEqual(followUp.dueAt, "2026-12-01T07:00:00.000Z");

          yield* runDueScan;
          assert.isNull((yield* followUps.snapshot({})).followUps[0]?.returnedAt);

          yield* TestClock.setTime(Date.UTC(2026, 11, 1, 7, 0, 1));
          yield* runDueScan;
          const returned = (yield* followUps.snapshot({})).followUps[0];
          assert.isNotNull(returned?.returnedAt);

          const later = yield* followUps.save(
            { id: followUp.id, dueAt: "2026-12-08T07:00:00Z" },
            agent,
          );
          assert.isNull(later.returnedAt);
        }),
      ),
  );

  it.effect("ranks title matches over body matches and leaves out closed ones", () =>
    withFollowUps(({ followUps }) =>
      Effect.gen(function* () {
        const inBody = yield* followUps.save(
          { title: "Fleet health", body: "The M2 forwarder check failed silently." },
          agent,
        );
        const inTitle = yield* followUps.save({ title: "M2 forwarder check" }, agent);
        const closed = yield* followUps.save({ title: "Old forwarder note" }, agent);
        yield* followUps.save({ id: closed.id, status: "dropped" }, agent);
        const matches = yield* followUps.search({ query: "forwarder check" });
        assert.deepEqual(
          matches.map((match) => match.followUp.id),
          [inTitle.id, inBody.id],
        );
        // An exact id reads it whatever its status.
        const byId = yield* followUps.search({ ids: [closed.id] });
        assert.deepEqual(
          byId.map((match) => match.followUp.id),
          [closed.id],
        );
      }),
    ),
  );
});
