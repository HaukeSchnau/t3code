import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ServerConfig } from "../config.ts";
import { ThreadWorkspaceService } from "../workspace/ThreadWorkspaceService.ts";
import { loadSkillPackCatalog, materializeSkillScope } from "../skills/SkillPackRuntime.ts";
import {
  ModelSelection,
  OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectionProjects from "../persistence/Services/ProjectionProjects.ts";
import {
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2RuntimePolicy as ProviderAdapterV2RuntimePolicyType,
} from "./ProviderAdapter.ts";

/**
 * ERRORS
 */
export class RuntimePolicyResolveError extends Schema.TaggedErrorClass<RuntimePolicyResolveError>()(
  "RuntimePolicyResolveError",
  {
    projectId: ProjectId,
    providerInstanceId: ProviderInstanceId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to resolve runtime policy for provider instance ${this.providerInstanceId} in project ${this.projectId}.`;
  }
}

export const RuntimePolicyV2Error = Schema.Union([RuntimePolicyResolveError]);
export type RuntimePolicyV2Error = typeof RuntimePolicyV2Error.Type;

export const RuntimePolicyV2Override = Schema.Struct({
  cwd: Schema.optional(Schema.String),
  approvalPolicy: Schema.optional(Schema.Unknown),
  sandboxPolicy: Schema.optional(Schema.Unknown),
  reasoningEffort: Schema.optional(Schema.String),
});
export type RuntimePolicyV2Override = typeof RuntimePolicyV2Override.Type;

/**
 * SERVICE DEFINITION
 */
export interface RuntimePolicyV2Shape {
  readonly resolve: (input: {
    readonly thread: OrchestrationV2AppThread;
    readonly modelSelection: ModelSelection;
  }) => Effect.Effect<ProviderAdapterV2RuntimePolicyType, RuntimePolicyV2Error>;
}

export class RuntimePolicyV2 extends Context.Service<RuntimePolicyV2, RuntimePolicyV2Shape>()(
  "t3/orchestration-v2/RuntimePolicy/RuntimePolicyV2",
) {}

/**
 * IMPLEMENTATIONS
 */
export const layer: Layer.Layer<RuntimePolicyV2> = Layer.succeed(RuntimePolicyV2, {
  resolve: (input) =>
    Effect.succeed({
      runtimeMode: input.thread.runtimeMode,
      interactionMode: input.thread.interactionMode,
      cwd: input.thread.worktreePath,
    }),
});

export const layerFromProjectRepository = Layer.effect(
  RuntimePolicyV2,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig;
    const projects = yield* ProjectionProjects.ProjectionProjectRepository;
    const workspaces = yield* ThreadWorkspaceService;
    return RuntimePolicyV2.of({
      resolve: Effect.fn("RuntimePolicyV2.resolve")(function* (input) {
        const workspaceCwd =
          input.thread.workspaceId == null
            ? undefined
            : yield* workspaces
                .resolvePrimaryCwd({
                  threadId: input.thread.id,
                  projectId: input.thread.projectId,
                  workspaceId: input.thread.workspaceId,
                })
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new RuntimePolicyResolveError({
                        projectId: input.thread.projectId,
                        providerInstanceId: input.modelSelection.instanceId,
                        cause,
                      }),
                  ),
                );
        const cwd =
          workspaceCwd ??
          input.thread.worktreePath ??
          (yield* projects.getById({ projectId: input.thread.projectId }).pipe(
            Effect.mapError(
              (cause) =>
                new RuntimePolicyResolveError({
                  projectId: input.thread.projectId,
                  providerInstanceId: input.modelSelection.instanceId,
                  cause,
                }),
            ),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(
                    new RuntimePolicyResolveError({
                      projectId: input.thread.projectId,
                      providerInstanceId: input.modelSelection.instanceId,
                      cause: "Project not found.",
                    }),
                  ),
                onSome: (project) => Effect.succeed(project.workspaceRoot),
              }),
            ),
          ));
        const selectedScope = input.thread.skillScope;
        const materialized =
          selectedScope === undefined
            ? undefined
            : yield* Effect.gen(function* () {
                const catalog = yield* loadSkillPackCatalog();
                return yield* materializeSkillScope({
                  catalog,
                  packIds: selectedScope.packIds,
                  version: selectedScope.version,
                });
              }).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(Path.Path, path),
                Effect.provideService(ServerConfig, config),
                Effect.catch((cause) =>
                  Effect.succeed({
                    scope: undefined,
                    issue:
                      cause instanceof Error
                        ? cause.message
                        : "The selected skill packs could not be prepared.",
                  }),
                ),
              );
        return ProviderAdapterV2RuntimePolicy.make({
          ...(materialized?.scope === undefined ? {} : { skillScope: materialized.scope }),
          ...(materialized?.issue === undefined ? {} : { skillScopeIssue: materialized.issue }),
          runtimeMode: input.thread.runtimeMode,
          interactionMode: input.thread.interactionMode,
          cwd,
        });
      }),
    });
  }),
);

export function layerWithOverride(
  override: RuntimePolicyV2Override,
): Layer.Layer<RuntimePolicyV2, never, RuntimePolicyV2> {
  return Layer.effect(
    RuntimePolicyV2,
    Effect.gen(function* () {
      const base = yield* RuntimePolicyV2;
      return {
        resolve: (input) =>
          base.resolve(input).pipe(
            Effect.map((policy) =>
              ProviderAdapterV2RuntimePolicy.make({
                ...policy,
                ...(override.cwd === undefined ? {} : { cwd: override.cwd }),
                ...(override.approvalPolicy === undefined
                  ? {}
                  : { approvalPolicy: override.approvalPolicy }),
                ...(override.sandboxPolicy === undefined
                  ? {}
                  : { sandboxPolicy: override.sandboxPolicy }),
                ...(override.reasoningEffort === undefined
                  ? {}
                  : { reasoningEffort: override.reasoningEffort }),
              }),
            ),
          ),
      } satisfies RuntimePolicyV2Shape;
    }),
  );
}
