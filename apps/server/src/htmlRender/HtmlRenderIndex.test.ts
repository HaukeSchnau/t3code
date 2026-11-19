import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadAskId,
  ThreadId,
  type HtmlRenderListPagesInput,
  type HtmlRenderPageChange,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as HtmlRenderIndex from "./HtmlRenderIndex.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for pages"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerOrchestrator = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "html-render-index" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);
const layerTest = Layer.merge(
  layerOrchestrator,
  HtmlRenderIndex.layer.pipe(Layer.provide(layerDatabase)),
);

const threadA = ThreadId.make("thread:pages-a");
const threadB = ThreadId.make("thread:pages-b");

const setup = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  for (const threadId of [threadA, threadB]) {
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:pages"),
      title: threadId === threadA ? "Settings redesign" : "CI times",
      modelSelection: { instanceId, model: "gpt-5.1-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  }
  return { orchestrator, index: yield* HtmlRenderIndex.HtmlRenderIndex };
});

const publish = (
  index: HtmlRenderIndex.HtmlRenderIndex["Service"],
  input: Parameters<HtmlRenderIndex.HtmlRenderIndex["Service"]["recordPublished"]>[0],
) => index.recordPublished(input).pipe(Effect.andThen(TestClock.adjust("1 second")));

const listed = (
  index: HtmlRenderIndex.HtmlRenderIndex["Service"],
  input: HtmlRenderListPagesInput,
) =>
  index.list(input).pipe(
    Effect.map(({ pages, nextCursor }) => ({
      pages: pages.map((page) => `${page.renderId}:${page.title}:${page.versionCount}`),
      nextCursor,
    })),
  );

it.effect("lists newest first in pages, and a new version moves forward unseen", () =>
  Effect.gen(function* () {
    const { index } = yield* setup;
    yield* publish(index, { threadId: threadA, attachmentId: "a1", title: "Layouts" });
    yield* publish(index, { threadId: threadA, attachmentId: "b1", title: "Copy" });
    yield* publish(index, { threadId: threadA, attachmentId: "c1", title: "Icons" });

    const first = yield* listed(index, { threadId: threadA, filter: "all", limit: 2 });
    assert.deepEqual(first.pages, ["c1:Icons:1", "b1:Copy:1"]);
    assert.isString(first.nextCursor);
    const rest = yield* listed(index, {
      threadId: threadA,
      filter: "all",
      limit: 2,
      cursor: first.nextCursor!,
    });
    assert.deepEqual(rest, { pages: ["a1:Layouts:1"], nextCursor: null });
    // One page by its render id, however far back it sorts, and only in its own thread.
    assert.deepEqual(
      yield* listed(index, { threadId: threadA, renderId: "a1", filter: "all", limit: 1 }),
      { pages: ["a1:Layouts:1"], nextCursor: null },
    );
    assert.deepEqual(
      (yield* listed(index, { threadId: threadB, renderId: "a1", filter: "all" })).pages,
      [],
    );

    yield* index.markSeen({ threadId: threadA, renderId: "a1", attachmentId: "a1" });
    yield* index.markSeen({ threadId: threadA, renderId: "b1", attachmentId: "b1" });
    // Another thread cannot mark this thread's page.
    yield* index.markSeen({ threadId: threadB, renderId: "c1", attachmentId: "c1" });
    assert.deepEqual((yield* listed(index, { threadId: threadA, filter: "unseen" })).pages, [
      "c1:Icons:1",
    ]);

    // A version without a title keeps the page's; a page never indexed stays out.
    yield* publish(index, {
      threadId: threadA,
      attachmentId: "a2",
      renderId: "a1",
      title: undefined,
    });
    yield* publish(index, { threadId: threadA, attachmentId: "x2", renderId: "x1", title: "Old" });
    const page = (yield* index.list({ threadId: threadA, filter: "unseen" })).pages[0]!;
    assert.deepInclude(page, {
      renderId: "a1",
      latestAttachmentId: "a2",
      title: "Layouts",
      versionCount: 2,
      seenAt: null,
      threadTitle: "Settings redesign",
    });
    // A view of the first version, still open on another device, does not mark the second.
    yield* index.markSeen({ threadId: threadA, renderId: "a1", attachmentId: "a1" });
    assert.deepEqual((yield* listed(index, { threadId: threadA, filter: "unseen" })).pages, [
      "a1:Layouts:2",
      "c1:Icons:1",
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("lists pages that ask, a thread's own first, and leaves deleted threads out", () =>
  Effect.gen(function* () {
    const { orchestrator, index } = yield* setup;
    yield* publish(index, { threadId: threadA, attachmentId: "a1", title: "Layouts" });
    yield* publish(index, { threadId: threadB, attachmentId: "b1", title: "Chart" });
    yield* publish(index, { threadId: threadA, attachmentId: "c1", title: "Icons" });
    yield* orchestrator.dispatch({
      type: "thread.ask.raise",
      commandId: CommandId.make("raise:a1"),
      threadId: threadA,
      askId: ThreadAskId.make("page:a1"),
      source: { type: "page", renderId: "a1" },
      text: "Pick one of 3 layouts",
    });

    // The list of every thread walks the newest-first index instead of sorting all pages.
    const statements: Array<ReturnType<Statement.Statement<unknown>["compile"]>> = [];
    const recordStatements = Effect.provideService(
      Statement.CurrentTransformer,
      (statement: Statement.Statement<unknown>) => {
        statements.push(statement.compile());
        return Effect.succeed(statement);
      },
    );
    const first = yield* index.list({ filter: "all", limit: 1 }).pipe(recordStatements);
    yield* index
      .list({ filter: "all", limit: 1, cursor: first.nextCursor! })
      .pipe(recordStatements);
    const sql = yield* SqlClient.SqlClient;
    for (const [query, params] of statements) {
      const plan = yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN ${query}`,
        params,
      );
      assert.isTrue(
        plan.some((row) => row.detail.includes("html_renders_latest_idx")) &&
          !plan.some((row) => row.detail.includes("TEMP B-TREE")),
        JSON.stringify(plan),
      );
    }

    const asks = (yield* index.list({ filter: "asks" })).pages;
    assert.deepEqual(
      asks.map((page) => [page.renderId, page.ask?.text]),
      [["a1", "Pick one of 3 layouts"]],
    );
    assert.deepEqual(
      (yield* index.list({ filter: "all" })).pages.map((page) => [page.renderId, page.ask?.text]),
      [
        ["c1", undefined],
        ["b1", undefined],
        ["a1", "Pick one of 3 layouts"],
      ],
    );
    // The thread's list cuts after its waiting page, however old, and goes on from there.
    const ofA = yield* listed(index, { threadId: threadA, filter: "all", limit: 1 });
    assert.deepEqual(ofA.pages, ["a1:Layouts:1"]);
    assert.deepEqual(
      yield* listed(index, { threadId: threadA, filter: "all", limit: 1, cursor: ofA.nextCursor! }),
      { pages: ["c1:Icons:1"], nextCursor: null },
    );

    yield* orchestrator.dispatch({
      type: "thread.ask.dismiss",
      commandId: CommandId.make("dismiss:a1"),
      threadId: threadA,
    });
    assert.deepEqual((yield* index.list({ filter: "asks" })).pages, []);

    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("delete:b"),
      threadId: threadB,
    });
    assert.deepEqual((yield* listed(index, { filter: "all" })).pages, [
      "c1:Icons:1",
      "a1:Layouts:1",
    ]);
    // A device still showing the deleted thread's page marks nothing.
    yield* index.markSeen({ threadId: threadB, renderId: "b1", attachmentId: "b1" });
    assert.deepEqual(yield* sql`SELECT seen_at FROM html_renders WHERE render_id = 'b1'`, [
      { seen_at: null },
    ]);
  }).pipe(Effect.provide(layerTest)),
);

const toolCall = (ordinal: number, toolName: string, structuredContent: object) => ({
  turn_item_id: `item:${ordinal}`,
  thread_id: threadA,
  ordinal,
  type: "dynamic_tool",
  status: "completed",
  updated_at: `2026-11-01T10:0${ordinal}:00.000Z`,
  payload_json: JSON.stringify({ toolName, output: { structuredContent } }),
});

it.effect("indexes a page shown before the index with its next versions, and only a real one", () =>
  Effect.gen(function* () {
    const { index } = yield* setup;
    const sql = yield* SqlClient.SqlClient;
    for (const row of [
      toolCall(1, "t3-code.html_render", {
        htmlRender: { attachmentId: "old1", title: "Old layouts", height: 300 },
      }),
      toolCall(2, "t3-code.html_render_update", {
        htmlRenderUpdate: { renderId: "old1", attachmentId: "old2" },
      }),
    ]) {
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert(row)}`;
    }

    // A later version, another thread, or no tool call at all is not a page to update.
    assert.isFalse(yield* index.isPage({ threadId: threadA, renderId: "old2" }));
    assert.isFalse(yield* index.isPage({ threadId: threadB, renderId: "old1" }));
    assert.isFalse(yield* index.isPage({ threadId: threadA, renderId: "upload1" }));
    assert.isTrue(yield* index.isPage({ threadId: threadA, renderId: "old1" }));
    // The check writes nothing, so an update that fails after it leaves the lists as they were.
    assert.deepEqual((yield* index.list({ threadId: threadA, filter: "all" })).pages, []);

    // Two first updates that both found no row read the tool calls before either writes one.
    const updateHeldAtToolCalls = (attachmentId: string) =>
      Effect.gen(function* () {
        const reading = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const update = yield* index
          .recordPublished({ threadId: threadA, attachmentId, renderId: "old1", title: undefined })
          .pipe(
            Effect.provideService(Statement.CurrentTransformer, (statement) =>
              statement.compile()[0].includes("FROM orchestration_v2_projection_turn_items")
                ? Deferred.succeed(reading, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.as(statement),
                  )
                : Effect.succeed(statement),
            ),
            Effect.forkChild,
          );
        yield* Deferred.await(reading);
        return Deferred.succeed(release, undefined).pipe(Effect.andThen(Fiber.join(update)));
      });
    const third = yield* updateHeldAtToolCalls("old3");
    const fourth = yield* updateHeldAtToolCalls("old4");
    yield* third;
    yield* fourth;

    assert.deepInclude((yield* index.list({ threadId: threadA, filter: "unseen" })).pages[0], {
      renderId: "old1",
      title: "Old layouts",
      firstPublishedAt: "2026-11-01T10:01:00.000Z",
      latestAttachmentId: "old4",
      versionCount: 4,
    });
    assert.isTrue(yield* index.isPage({ threadId: threadA, renderId: "old1" }));
  }).pipe(Effect.provide(layerTest)),
);

// Every event since the database opened, so no change slips past before the index listens.
const layerThreadEvents = Layer.unwrap(
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    return Layer.mock(ThreadManagementService.ThreadManagementService)({
      streamDomainEvents: sink.stream({ afterSequence: 0 }).pipe(
        Stream.map((stored) => stored.event),
        Stream.orDie,
      ),
    });
  }),
);
const layerWithThreadChanges = Layer.merge(
  layerOrchestrator,
  HtmlRenderIndex.layerWithThreadChanges.pipe(
    Layer.provide(
      Layer.merge(layerThreadEvents.pipe(Layer.provide(layerOrchestrator)), layerDatabase),
    ),
  ),
);

const follow = (index: HtmlRenderIndex.HtmlRenderIndex["Service"], threadId?: ThreadId) =>
  Effect.gen(function* () {
    const changes = yield* Queue.unbounded<HtmlRenderPageChange>();
    yield* index.changes(threadId).pipe(
      Stream.runForEach((change) => Queue.offer(changes, change)),
      Effect.forkScoped({ startImmediately: true }),
    );
    return changes;
  });

it.effect("tells each thread's lists about that thread's changes only", () =>
  Effect.gen(function* () {
    const { orchestrator, index } = yield* setup;
    yield* publish(index, { threadId: threadA, attachmentId: "a1", title: "Layouts" });
    const ofA = yield* follow(index, threadA);
    const ofB = yield* follow(index, threadB);
    const all = yield* follow(index);
    assert.deepEqual(yield* Queue.take(ofA), { revision: 0, pages: 1 });
    assert.deepEqual(yield* Queue.take(ofB), { revision: 0, pages: 0 });
    assert.deepEqual(yield* Queue.take(all), { revision: 0, pages: 1 });

    // B has no pages yet, so its rename and settling change no list.
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("rename:b"),
      threadId: threadB,
      title: "CI times, weekly",
    });
    yield* orchestrator.dispatch({
      type: "thread.settle",
      commandId: CommandId.make("settle:b"),
      threadId: threadB,
    });
    // Events arrive in order, so once A's ask shows, B's earlier changes were passed over.
    yield* orchestrator.dispatch({
      type: "thread.ask.raise",
      commandId: CommandId.make("raise:a1"),
      threadId: threadA,
      askId: ThreadAskId.make("page:a1"),
      source: { type: "page", renderId: "a1" },
      text: "Pick one of 3 layouts",
    });
    // Each count is taken when its change arrives, so take it before the next change.
    assert.deepEqual(yield* Queue.take(ofA), { revision: 1, pages: 1 });
    assert.deepEqual(yield* Queue.take(all), { revision: 1, pages: 1 });
    yield* publish(index, { threadId: threadB, attachmentId: "b1", title: "Chart" });
    assert.deepEqual(yield* Queue.take(ofB), { revision: 1, pages: 1 });
    assert.deepEqual(yield* Queue.take(all), { revision: 2, pages: 2 });

    // A rename, settling (which ends the ask) and deletion change A's lists; B's page did not.
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("rename:a"),
      threadId: threadA,
      title: "Settings, round 2",
    });
    assert.deepEqual(yield* Queue.take(ofA), { revision: 2, pages: 1 });
    yield* orchestrator.dispatch({
      type: "thread.settle",
      commandId: CommandId.make("settle:a"),
      threadId: threadA,
    });
    assert.deepEqual(yield* Queue.take(ofA), { revision: 3, pages: 1 });
    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("delete:a"),
      threadId: threadA,
    });
    assert.deepEqual(yield* Queue.take(ofA), { revision: 4, pages: 0 });
    yield* index.markSeen({ threadId: threadB, renderId: "b1", attachmentId: "b1" });
    assert.deepEqual(yield* Queue.take(ofB), { revision: 2, pages: 1 });
  }).pipe(Effect.scoped, Effect.provide(layerWithThreadChanges)),
);
