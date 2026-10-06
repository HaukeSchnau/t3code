import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  SkillPackId,
  type SkillPackSubscribeInput,
  ThreadId,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import * as ProviderScope from "./SkillPackProviderScope.ts";
import * as SkillPacks from "./SkillPacks.ts";

const web = SkillPackId.make("web-motion");
const effectPack = SkillPackId.make("effect");
const codex = ProviderInstanceId.make("codex");
const cursor = ProviderInstanceId.make("cursor");
const providerSessionId = ProviderSessionId.make("provider-session-1");
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const adapter = (instanceId: ProviderInstanceId, driver: string) => ({
  instanceId,
  driver: ProviderDriverKind.make(driver),
  getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.die("unused planSelectionTransition"),
  openSession: () => Effect.die("unused openSession"),
});

const thread = (id: string, projectId: ProjectId, parent: string | null = null) => ({
  id: ThreadId.make(id),
  projectId,
  lineage: {
    parentThreadId: parent === null ? null : ThreadId.make(parent),
    relationshipToParent: parent === null ? null : ("fork" as const),
    rootThreadId: ThreadId.make(parent ?? id),
  },
});

/** One project, a catalog with one linkable pack and one pack whose skill is missing. */
const withSkillPacks = <A, E>(
  body: (context: {
    readonly projectId: ProjectId;
    readonly detached: ReadonlyArray<ThreadId>;
    readonly skillPacks: SkillPacks.SkillPacks["Service"];
  }) => Effect.Effect<A, E, SkillPacks.SkillPacks>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sql = yield* SqlClient.SqlClient;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-skill-packs-" });
    const animate = path.join(baseDir, "canonical", "animate");
    yield* fileSystem.makeDirectory(animate, { recursive: true });
    yield* fileSystem.writeFileString(path.join(animate, "SKILL.md"), "animate");
    const catalogPath = path.join(baseDir, "catalog.json");
    yield* fileSystem.writeFileString(
      catalogPath,
      encodeJson({
        version: 1,
        coreSkillIds: [],
        skills: [{ id: "animate", path: animate }],
        packs: [
          { id: web, displayName: "Web motion", description: "Motion", skillIds: ["animate"] },
          {
            id: effectPack,
            displayName: "Effect",
            description: "Effect",
            skillIds: ["effect-docs"],
          },
        ],
        profiles: [],
      }),
    );

    yield* runMigrations();
    const projectId = ProjectId.make(`project-${path.basename(baseDir)}`);
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, scripts_json, created_at, updated_at
      )
      VALUES (
        ${projectId}, 'Project', '/tmp/project', '[]',
        '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'
      )
    `;

    const detached: Array<ThreadId> = [];
    const dependencies = Layer.mergeAll(
      ProjectionStore.layerMemory,
      ServerConfig.layerTest(baseDir, baseDir),
      Layer.succeed(
        ProviderAdapterRegistry.ProviderAdapterRegistryV2,
        ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
          get: (instanceId) =>
            Effect.succeed(adapter(instanceId, instanceId === cursor ? "cursor" : "codex")),
          list: () => Effect.succeed([codex, cursor]),
        }),
      ),
      Layer.succeed(
        ProviderSessionManager.ProviderSessionManagerV2,
        ProviderSessionManager.ProviderSessionManagerV2.of({
          shutdown: Effect.void,
          open: () => Effect.die("unused open"),
          get: () => Effect.die("unused get"),
          close: () => Effect.die("unused close"),
          closeInstance: () => Effect.die("unused closeInstance"),
          release: () => Effect.die("unused release"),
          detach: (input) => Effect.sync(() => void detached.push(input.threadId)),
        }),
      ),
    );
    return yield* Effect.gen(function* () {
      const skillPacks = yield* SkillPacks.SkillPacks;
      return yield* body({ projectId, detached, skillPacks });
    }).pipe(
      Effect.provide(SkillPacks.layer.pipe(Layer.provide(dependencies))),
      Effect.provideService(HostProcessEnvironment, { T3CODE_SKILL_CATALOG_PATH: catalogPath }),
    );
  });

const firstState = (skillPacks: SkillPacks.SkillPacks["Service"], input: SkillPackSubscribeInput) =>
  skillPacks.subscribe(input).pipe(Stream.runHead, Effect.flatMap(Effect.fromOption));

describe("SkillPacks", () => {
  it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory(), NodeServices.layer))("service", (it) => {
    it.effect("a new thread follows the project default until its first turn applies it", () =>
      withSkillPacks(({ projectId, skillPacks }) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make("new-thread");
          yield* skillPacks.setProjectDefault({ projectId, packIds: [web] });
          assert.deepStrictEqual(yield* firstState(skillPacks, { projectId, threadId }), {
            projectDefaultPackIds: [web],
            thread: { packIds: [web], state: "pending" },
          });

          yield* skillPacks.prepareTurn({
            thread: thread("new-thread", projectId),
            providerSessionId,
            providerInstanceId: codex,
          });
          assert.deepStrictEqual((yield* firstState(skillPacks, { projectId, threadId })).thread, {
            packIds: [web],
            state: "ready",
          });
          assert.equal(ProviderScope.claudeSkillPackPlugins(threadId).plugins?.length, 1);

          // The thread keeps its packs when the project default changes later.
          yield* skillPacks.setProjectDefault({ projectId, packIds: [] });
          assert.deepStrictEqual(
            (yield* firstState(skillPacks, { projectId, threadId })).thread?.packIds,
            [web],
          );
        }),
      ),
    );

    it.effect("streams a selection change to subscribers", () =>
      withSkillPacks(({ projectId, skillPacks }) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make("streamed-thread");
          const subscribed = yield* Deferred.make<void>();
          const states = yield* skillPacks.subscribe({ projectId, threadId }).pipe(
            Stream.tap(() => Deferred.succeed(subscribed, undefined)),
            Stream.take(2),
            Stream.runCollect,
            Effect.forkChild,
          );
          yield* Deferred.await(subscribed);
          yield* skillPacks.setThreadPacks({ threadId, packIds: [web] });
          assert.deepStrictEqual(
            Array.from(yield* Fiber.join(states)).map((state) => state.thread),
            [
              { packIds: [], state: "ready" },
              { packIds: [web], state: "pending" },
            ],
          );
        }),
      ),
    );

    it.effect("reloads a provider thread that still holds an older selection", () =>
      withSkillPacks(({ projectId, detached, skillPacks }) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make("changed-thread");
          const turn = {
            thread: thread("changed-thread", projectId),
            providerSessionId,
            providerInstanceId: codex,
          };
          yield* skillPacks.setThreadPacks({ threadId, packIds: [web] });
          yield* skillPacks.prepareTurn(turn);
          // The provider loads the thread with the web pack.
          ProviderScope.claudeSkillPackPlugins(threadId);
          assert.deepStrictEqual(detached, []);

          yield* skillPacks.setThreadPacks({ threadId, packIds: [] });
          assert.equal(
            (yield* firstState(skillPacks, { projectId, threadId })).thread?.state,
            "pending",
          );
          yield* skillPacks.prepareTurn(turn);
          assert.deepStrictEqual(detached, [threadId]);
          assert.deepStrictEqual((yield* firstState(skillPacks, { projectId, threadId })).thread, {
            packIds: [],
            state: "ready",
          });
          assert.deepStrictEqual(ProviderScope.claudeSkillPackPlugins(threadId), {});
        }),
      ),
    );

    it.effect("forks start with their parent's packs", () =>
      withSkillPacks(({ projectId, skillPacks }) =>
        Effect.gen(function* () {
          yield* skillPacks.setThreadPacks({ threadId: ThreadId.make("parent"), packIds: [web] });
          yield* skillPacks.prepareTurn({
            thread: thread("fork", projectId, "parent"),
            providerSessionId,
            providerInstanceId: codex,
          });
          assert.deepStrictEqual(
            (yield* firstState(skillPacks, { projectId, threadId: ThreadId.make("fork") })).thread,
            { packIds: [web], state: "ready" },
          );
        }),
      ),
    );

    it.effect("degrades when the provider or the catalog cannot supply the packs", () =>
      withSkillPacks(({ projectId, skillPacks }) =>
        Effect.gen(function* () {
          const cursorThread = ThreadId.make("cursor-thread");
          yield* skillPacks.setThreadPacks({ threadId: cursorThread, packIds: [web] });
          yield* skillPacks.prepareTurn({
            thread: thread("cursor-thread", projectId),
            providerSessionId,
            providerInstanceId: cursor,
          });
          const unsupported = (yield* firstState(skillPacks, {
            projectId,
            threadId: cursorThread,
          })).thread;
          assert.equal(unsupported?.state, "degraded");
          assert.match(unsupported?.issue ?? "", /cannot load skill packs/u);
          assert.deepStrictEqual(ProviderScope.claudeSkillPackPlugins(cursorThread), {});

          const missingThread = ThreadId.make("missing-thread");
          yield* skillPacks.setThreadPacks({ threadId: missingThread, packIds: [effectPack] });
          yield* skillPacks.prepareTurn({
            thread: thread("missing-thread", projectId),
            providerSessionId,
            providerInstanceId: codex,
          });
          assert.deepStrictEqual(
            (yield* firstState(skillPacks, { projectId, threadId: missingThread })).thread,
            { packIds: [effectPack], state: "degraded", issue: "Missing skills: effect-docs" },
          );
        }),
      ),
    );
  });
});

describe("skillPackSupportIssue", () => {
  it("loads packs only where the provider can scope them to one thread", () => {
    const supported = (driver: string, sharedSession = false, externalServer = false) =>
      SkillPacks.skillPackSupportIssue({ driver, sharedSession, externalServer }) === undefined;
    assert.isTrue(supported("codex", true));
    assert.isTrue(supported("claudeAgent"));
    assert.isTrue(supported("opencode"));
    assert.isFalse(supported("opencode", true));
    assert.isFalse(supported("opencode", false, true));
    assert.isFalse(supported("cursor"));
  });
});
