import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import {
  type OrchestrationV2AppThread,
  type ProjectId,
  type ProviderInstanceId,
  type ProviderSessionId,
  type SkillPackCatalog,
  SkillPackError,
  SkillPackId,
  type SkillPackSetProjectDefaultInput,
  type SkillPackSetThreadInput,
  SkillPackState,
  type SkillPackSubscribeInput,
  type ThreadId,
  type ThreadSkillScope,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  allPackSkills,
  decodeRuntimeSkillPackCatalog,
  materializeSkillRoot,
  type MaterializedSkillRoot,
  publicSkillPackCatalog,
  type RuntimeSkillPackCatalog,
  selectPackSkills,
} from "./SkillPackCatalog.ts";
import * as ProviderScope from "./SkillPackProviderScope.ts";

export class SkillPacks extends Context.Service<
  SkillPacks,
  {
    /** Path-free catalog for clients; null when the environment publishes none. */
    readonly catalog: SkillPackCatalog | null;
    readonly subscribe: (
      input: SkillPackSubscribeInput,
    ) => Stream.Stream<SkillPackState, SkillPackError>;
    readonly setThreadPacks: (
      input: SkillPackSetThreadInput,
    ) => Effect.Effect<void, SkillPackError>;
    readonly setProjectDefault: (
      input: SkillPackSetProjectDefaultInput,
    ) => Effect.Effect<void, SkillPackError>;
    /**
     * Hand the thread's packs to its provider before a turn opens the session.
     * A provider thread loaded with another selection is detached so the turn
     * reloads it. Never fails the turn; problems degrade the thread's scope.
     */
    readonly prepareTurn: (input: {
      readonly thread: Pick<OrchestrationV2AppThread, "id" | "projectId" | "lineage">;
      readonly providerSessionId: ProviderSessionId;
      readonly providerInstanceId: ProviderInstanceId;
    }) => Effect.Effect<void>;
  }
>()("t3/skills/SkillPacks") {}

const PackIdsJson = Schema.fromJsonString(Schema.Array(SkillPackId));
const decodePackIds = Schema.decodeUnknownOption(PackIdsJson);
const encodePackIds = Schema.encodeSync(PackIdsJson);
const decodeServerUrl = Schema.decodeUnknownOption(
  Schema.Struct({ serverUrl: Schema.optional(Schema.String) }),
);
const sameState = Schema.toEquivalence(SkillPackState);

const UNSUPPORTED_PROVIDER =
  "This provider cannot load skill packs. Its own skills still work; selected packs are ignored.";

interface SelectionRow {
  readonly packIds: ReadonlyArray<SkillPackId>;
  /** What the provider last received; null until the thread's first turn. */
  readonly appliedPackIds: ReadonlyArray<SkillPackId> | null;
  readonly issue: string | null;
}

function sameIds(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((id) => right.includes(id));
}

/** A thread without its own row follows its fork parent, then its project. */
export function threadSkillScope(
  row: SelectionRow | undefined,
  inheritedPackIds: ReadonlyArray<SkillPackId>,
): ThreadSkillScope {
  const packIds = row?.packIds ?? inheritedPackIds;
  const applied = row?.appliedPackIds ?? null;
  const pending = applied === null ? packIds.length > 0 : !sameIds(applied, packIds);
  if (pending) return { packIds, state: "pending" };
  return row?.issue
    ? { packIds, state: "degraded", issue: row.issue }
    : { packIds, state: "ready" };
}

/**
 * Codex scopes skills per thread inside one shared app-server; OpenCode 2 has
 * no such control, and an external OpenCode server cannot see local paths.
 */
export function skillPackSupportIssue(input: {
  readonly driver: string;
  readonly sharedSession: boolean;
  readonly externalServer: boolean;
}): string | undefined {
  switch (input.driver) {
    case "codex":
    case "claudeAgent":
      return undefined;
    case "opencode":
      return input.sharedSession || input.externalServer ? UNSUPPORTED_PROVIDER : undefined;
    default:
      return UNSUPPORTED_PROVIDER;
  }
}

const loadCatalog = Effect.gen(function* () {
  const catalogPath = (yield* HostProcessEnvironment).T3CODE_SKILL_CATALOG_PATH?.trim();
  if (!catalogPath) return null;
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.readFileString(catalogPath).pipe(
    Effect.flatMap(decodeRuntimeSkillPackCatalog),
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not load the skill pack catalog.", {
        catalogPath,
        cause: Cause.pretty(cause),
      }).pipe(Effect.as(null)),
    ),
  );
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const serverSettings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  const catalog: RuntimeSkillPackCatalog | null = yield* loadCatalog;
  const changes = yield* PubSub.unbounded<{
    readonly projectId?: ProjectId;
    readonly threadId?: ThreadId;
  }>();
  // Serializes link creation for selections that share a directory.
  const materializeLock = yield* Semaphore.make(1);

  const materialize = (skills: Parameters<typeof materializeSkillRoot>[1]) =>
    materializeLock.withPermit(
      materializeSkillRoot(serverConfig.stateDir, skills).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      ),
    );

  if (catalog !== null) {
    const packSkills = allPackSkills(catalog);
    if (packSkills.length > 0) {
      ProviderScope.setCodexPackRoot(
        yield* materialize(packSkills).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not link skill pack skills for Codex.", {
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(undefined)),
          ),
        ),
      );
    }
  }

  const failure = (message: string) => (cause: unknown) => new SkillPackError({ message, cause });

  const readRow = (threadId: ThreadId) =>
    sql<{
      readonly pack_ids_json: string;
      readonly applied_pack_ids_json: string | null;
      readonly issue: string | null;
    }>`
      SELECT pack_ids_json, applied_pack_ids_json, issue
      FROM skill_pack_thread_selections
      WHERE thread_id = ${threadId}
    `.pipe(
      Effect.map((rows): SelectionRow | undefined => {
        const row = rows[0];
        if (row === undefined) return undefined;
        return {
          packIds: Option.getOrElse(decodePackIds(row.pack_ids_json), () => []),
          appliedPackIds:
            row.applied_pack_ids_json === null
              ? null
              : Option.getOrElse(decodePackIds(row.applied_pack_ids_json), () => []),
          issue: row.issue,
        };
      }),
    );

  const readProjectDefault = (projectId: ProjectId) =>
    sql<{ readonly default_skill_pack_ids_json: string }>`
      SELECT default_skill_pack_ids_json
      FROM projection_projects
      WHERE project_id = ${projectId}
    `.pipe(
      Effect.map((rows) =>
        rows[0] === undefined
          ? []
          : Option.getOrElse(decodePackIds(rows[0].default_skill_pack_ids_json), () => []),
      ),
    );

  /** Bounded walk up the fork chain; stops at the first thread with its own packs. */
  const inheritedPackIds = Effect.fnUntraced(function* (
    thread: Pick<OrchestrationV2AppThread, "projectId" | "lineage">,
  ) {
    let parentThreadId = thread.lineage.parentThreadId;
    for (let depth = 0; parentThreadId !== null && depth < 16; depth += 1) {
      const parentRow = yield* readRow(parentThreadId);
      if (parentRow !== undefined) return parentRow.packIds;
      const parent = yield* projectionStore.getThread(parentThreadId).pipe(Effect.option);
      if (Option.isNone(parent)) break;
      parentThreadId = parent.value.lineage.parentThreadId;
    }
    return yield* readProjectDefault(thread.projectId);
  });

  const readState = (input: SkillPackSubscribeInput) =>
    Effect.gen(function* () {
      const projectDefaultPackIds = yield* readProjectDefault(input.projectId);
      if (input.threadId === undefined) return { projectDefaultPackIds, thread: null };
      const row = yield* readRow(input.threadId);
      if (row !== undefined) {
        return { projectDefaultPackIds, thread: threadSkillScope(row, []) };
      }
      const thread = yield* projectionStore.getThread(input.threadId).pipe(Effect.option);
      const inherited = Option.isSome(thread)
        ? yield* inheritedPackIds(thread.value)
        : projectDefaultPackIds;
      return { projectDefaultPackIds, thread: threadSkillScope(undefined, inherited) };
    }).pipe(Effect.mapError(failure("Could not read skill packs.")));

  const subscribe: SkillPacks["Service"]["subscribe"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before the first read so a change in between is not lost.
        const subscription = yield* PubSub.subscribe(changes);
        return Stream.concat(
          Stream.fromEffect(readState(input)),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter(
              (change) =>
                change.projectId === input.projectId ||
                (input.threadId !== undefined && change.threadId === input.threadId),
            ),
            Stream.mapEffect(() => readState(input)),
          ),
        ).pipe(Stream.changesWith(sameState));
      }),
    );

  const setThreadPacks: SkillPacks["Service"]["setThreadPacks"] = (input) =>
    Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO skill_pack_thread_selections (thread_id, pack_ids_json, updated_at)
        VALUES (${input.threadId}, ${encodePackIds(input.packIds)}, ${now})
        ON CONFLICT (thread_id) DO UPDATE SET
          pack_ids_json = excluded.pack_ids_json,
          updated_at = excluded.updated_at
      `;
      yield* PubSub.publish(changes, { threadId: input.threadId });
    }).pipe(Effect.mapError(failure("Could not save the thread's skill packs.")));

  const setProjectDefault: SkillPacks["Service"]["setProjectDefault"] = (input) =>
    Effect.gen(function* () {
      const updated = yield* sql<{ readonly project_id: string }>`
        UPDATE projection_projects
        SET default_skill_pack_ids_json = ${encodePackIds(input.packIds)}
        WHERE project_id = ${input.projectId}
        RETURNING project_id
      `.pipe(Effect.mapError(failure("Could not save the project's default skill packs.")));
      if (updated.length === 0) {
        return yield* new SkillPackError({ message: "The project no longer exists." });
      }
      yield* PubSub.publish(changes, { projectId: input.projectId });
    });

  const supportIssue = Effect.fnUntraced(function* (instanceId: ProviderInstanceId) {
    const adapter = yield* adapters.get(instanceId);
    const capabilities = yield* adapter.getCapabilities();
    const settings = Option.isSome(serverSettings)
      ? yield* serverSettings.value.getSettings.pipe(Effect.option)
      : Option.none();
    const instanceConfig = Option.map(
      settings,
      (current) => deriveProviderInstanceConfigMap(current)[instanceId]?.config,
    );
    const serverUrl = Option.flatMap(instanceConfig, decodeServerUrl).pipe(
      Option.flatMap((config) => Option.fromUndefinedOr(config.serverUrl)),
    );
    return skillPackSupportIssue({
      driver: adapter.driver,
      sharedSession: capabilities.sessions.supportsMultipleProviderThreadsPerSession,
      externalServer: Option.isSome(serverUrl) && serverUrl.value.trim().length > 0,
    });
  });

  const resolveScope = Effect.fnUntraced(function* (
    packIds: ReadonlyArray<SkillPackId>,
    instanceId: ProviderInstanceId,
  ): Effect.fn.Return<{
    readonly scope?: MaterializedSkillRoot;
    readonly issue?: string;
  }> {
    if (packIds.length === 0) return {};
    if (catalog === null) return { issue: "This environment has no skill pack catalog." };
    const unsupported = yield* supportIssue(instanceId).pipe(
      Effect.catchCause(() => Effect.succeed(UNSUPPORTED_PROVIDER)),
    );
    if (unsupported !== undefined) return { issue: unsupported };
    const { skills, problems } = selectPackSkills(catalog, packIds);
    const issue = problems.length > 0 ? problems.join(". ") : undefined;
    if (skills.length === 0) return issue === undefined ? {} : { issue };
    return yield* materialize(skills).pipe(
      Effect.map((scope) => (issue === undefined ? { scope } : { scope, issue })),
      Effect.catchCause((cause) =>
        Effect.succeed({ issue: `Could not link the selected skills: ${Cause.pretty(cause)}` }),
      ),
    );
  });

  const prepareTurn: SkillPacks["Service"]["prepareTurn"] = (input) =>
    Effect.gen(function* () {
      const threadId = input.thread.id;
      const row = yield* readRow(threadId);
      // Without a catalog a thread that never picked packs has nothing to apply or report.
      if (catalog === null && row === undefined) return;
      const packIds = row?.packIds ?? (yield* inheritedPackIds(input.thread));
      const { scope, issue } = yield* resolveScope(packIds, input.providerInstanceId);
      ProviderScope.setThreadSkillScope(threadId, scope);
      const loadedKey = ProviderScope.loadedSkillScopeKey(threadId);
      if (loadedKey !== undefined && loadedKey !== (scope?.key ?? "")) {
        // A no-op when the session is gone. A single-thread session closes;
        // a shared Codex session unloads only this thread.
        yield* sessions.detach({
          providerSessionId: input.providerSessionId,
          threadId,
          detail: "Skill packs changed.",
        });
      }
      const now = DateTime.formatIso(yield* DateTime.now);
      const applied = encodePackIds(packIds);
      yield* sql`
        INSERT INTO skill_pack_thread_selections (
          thread_id,
          pack_ids_json,
          applied_pack_ids_json,
          issue,
          updated_at
        )
        VALUES (${threadId}, ${applied}, ${applied}, ${issue ?? null}, ${now})
        ON CONFLICT (thread_id) DO UPDATE SET
          applied_pack_ids_json = excluded.applied_pack_ids_json,
          issue = excluded.issue,
          updated_at = excluded.updated_at
      `;
      yield* PubSub.publish(changes, { threadId });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not prepare skill packs for the turn.", {
          threadId: input.thread.id,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  return SkillPacks.of({
    catalog: catalog === null ? null : publicSkillPackCatalog(catalog),
    subscribe,
    setThreadPacks,
    setProjectDefault,
    prepareTurn,
  });
});

export const layer = Layer.effect(SkillPacks, make);
