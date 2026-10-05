import { assert, describe, it, vi } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ProjectStore from "./ProjectStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadTitleRefresh from "./ThreadTitleRefresh.ts";
import * as ThreadTitleRegeneration from "./ThreadTitleRegenerationService.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const projectId = ProjectId.make("project:title-refresh");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in title refresh tests"),
} as ProviderAdapterV2Shape;

function makeHarness(
  options: {
    readonly generateTitle?: TextGeneration.TextGeneration["Service"]["generateThreadTitle"];
    readonly refreshGeneratedThreadTitles?: boolean;
  } = {},
) {
  const database = SqlitePersistenceMemory;
  const orchestrator = makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "thread-title-refresh" },
    ProviderAdapterRegistry.makeLayer([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  );
  const threadManagement = ThreadManagement.layer.pipe(Layer.provide(orchestrator));
  const generateThreadTitle = vi.fn(
    options.generateTitle ?? (() => Effect.succeed({ title: "Refined title" })),
  );
  const projects = Layer.mock(ProjectStore.ProjectStoreV2)({
    get: (requestedProjectId) =>
      Effect.succeed(
        requestedProjectId === projectId
          ? Option.some({
              projectId,
              title: "Project",
              workspaceRoot: "/repo",
              defaultModelSelection: modelSelection,
              defaultThreadEnvMode: null,
              autoPull: false,
              faviconPath: null,
              projectIcon: null,
              scripts: [],
              createdAt: "2026-06-20T00:00:00.000Z",
              updatedAt: "2026-06-20T00:00:00.000Z",
              deletedAt: null,
            })
          : Option.none(),
      ),
  });
  const dependencies = Layer.mergeAll(
    threadManagement,
    projects,
    Layer.mock(TextGeneration.TextGeneration)({ generateThreadTitle }),
    ServerSettings.layerTest(
      options.refreshGeneratedThreadTitles === undefined
        ? {}
        : { refreshGeneratedThreadTitles: options.refreshGeneratedThreadTitles },
    ),
  );
  return {
    layer: Layer.mergeAll(
      dependencies,
      ThreadTitleRegeneration.layer.pipe(Layer.provide(dependencies)),
    ),
    generateThreadTitle,
  };
}

const createThread = (thread: string) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const threadId = ThreadId.make(thread);
    yield* threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`${thread}:create`),
      threadId,
      projectId,
      title: "Seed title",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    return threadId;
  });

const sendUserMessage = (threadId: ThreadId, key: string, titleSeed?: string) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`${threadId}:${key}`),
      threadId,
      messageId: MessageId.make(`${threadId}:${key}:message`),
      text: `User request ${key}`,
      attachments: [],
      ...(titleSeed === undefined ? {} : { titleSeed }),
      modelSelection,
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
  });

const rename = (threadId: ThreadId, title: string) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* threads.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make(`${threadId}:rename:${title}`),
      threadId,
      title,
    });
  });

const readThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    return (yield* threads.getThreadProjection(threadId)).thread;
  });

describe("title mode", () => {
  it.effect("a rename makes a title manual and regeneration makes it automatic again", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        generateTitle: () => Effect.succeed({ title: "Regenerated title" }),
      });
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const regeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const threadId = yield* createThread("thread:title-mode");
        assert.equal((yield* readThread(threadId)).titleMode, "automatic");

        yield* sendUserMessage(threadId, "first");
        yield* rename(threadId, "My title");
        assert.equal((yield* readThread(threadId)).titleMode, "manual");

        const requestId = CommandId.make("thread:title-mode:regenerate");
        yield* threads.dispatch({
          type: "thread.metadata.update",
          commandId: requestId,
          threadId,
          regenerateTitle: true,
        });
        yield* regeneration.execute({ threadId, requestId, kind: { type: "regenerate" } });

        const thread = yield* readThread(threadId);
        assert.equal(thread.title, "Regenerated title");
        assert.equal(thread.titleMode, "automatic");
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("keeps a manual title when the first message arrives", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threadId = yield* createThread("thread:manual-first-message");
        yield* rename(threadId, "Named before sending");
        yield* sendUserMessage(threadId, "first", "User request first");

        const thread = yield* readThread(threadId);
        assert.equal(thread.title, "Named before sending");
        assert.isNotOk(thread.titleRegeneration);
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});

describe("ThreadTitleRefresh", () => {
  it.effect("refreshes an automatic title once after a burst of later turns", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const refresh = yield* ThreadTitleRefresh.make;
        const threadId = yield* createThread("thread:refresh");
        yield* sendUserMessage(threadId, "first");
        yield* sendUserMessage(threadId, "second");

        yield* refresh.schedule(threadId);
        yield* TestClock.adjust("3 seconds");
        yield* refresh.schedule(threadId);
        yield* TestClock.adjust("3 seconds");
        assert.equal(harness.generateThreadTitle.mock.calls.length, 0);
        yield* TestClock.adjust("2 seconds");
        yield* refresh.drain;

        assert.equal(harness.generateThreadTitle.mock.calls.length, 1);
        const input = harness.generateThreadTitle.mock.calls[0]?.[0];
        assert.equal(input?.previousTitle, "Seed title");
        assert.isTrue(input?.automaticRefresh);
        assert.include(input?.message, "USER:\nUser request second");
        const thread = yield* readThread(threadId);
        assert.equal(thread.title, "Refined title");
        assert.equal(thread.titleMode, "automatic");
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  for (const skipped of ["first turn", "manual title", "setting off"] as const) {
    it.effect(`leaves the title alone: ${skipped}`, () =>
      Effect.gen(function* () {
        const harness = makeHarness({ refreshGeneratedThreadTitles: skipped !== "setting off" });
        yield* Effect.gen(function* () {
          const refresh = yield* ThreadTitleRefresh.make;
          const threadId = yield* createThread(`thread:skip:${skipped}`);
          yield* sendUserMessage(threadId, "first");
          if (skipped !== "first turn") yield* sendUserMessage(threadId, "second");
          if (skipped === "manual title") yield* rename(threadId, "My title");

          yield* refresh.schedule(threadId);
          yield* TestClock.adjust("5 seconds");
          yield* refresh.drain;

          assert.equal(harness.generateThreadTitle.mock.calls.length, 0);
          assert.equal(
            (yield* readThread(threadId)).title,
            skipped === "manual title" ? "My title" : "Seed title",
          );
        }).pipe(Effect.provide(harness.layer));
      }),
    );
  }

  it.effect("a rename during an in-flight refresh wins", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const harness = makeHarness({
        generateTitle: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as({ title: "Refined title" }),
          ),
      });
      yield* Effect.gen(function* () {
        const refresh = yield* ThreadTitleRefresh.make;
        const threadId = yield* createThread("thread:refresh-race");
        yield* sendUserMessage(threadId, "first");
        yield* sendUserMessage(threadId, "second");

        yield* refresh.schedule(threadId);
        yield* TestClock.adjust("5 seconds");
        yield* Deferred.await(started);
        yield* rename(threadId, "Renamed meanwhile");
        yield* Deferred.succeed(release, undefined);
        yield* refresh.drain;

        const thread = yield* readThread(threadId);
        assert.equal(thread.title, "Renamed meanwhile");
        assert.equal(thread.titleMode, "manual");
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});
