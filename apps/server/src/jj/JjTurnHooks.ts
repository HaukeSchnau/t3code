import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { VcsTurnHookError, VcsTurnHooks } from "../orchestration-v2/VcsTurnHooks.ts";
import * as ManagedWorkspaces from "../workspace/ManagedWorkspaces.ts";
import * as JjTurnService from "./JjTurnService.ts";

/** Turn hooks backed by jj; working copies that are not jj fall through to no-ops. */
export const layer = Layer.effect(
  VcsTurnHooks,
  Effect.gen(function* () {
    const turns = yield* JjTurnService.JjTurnService;
    const threads = yield* ProjectionStore.ProjectionStoreV2;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const workspaces = yield* ManagedWorkspaces.ManagedWorkspaces;
    const toHookError = (cause: JjTurnService.JjTurnError) =>
      new VcsTurnHookError({ detail: cause.message, cause });

    /** A thread's working copy: its workspace, or its project's checkout. */
    const workingCopyOf = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const thread = yield* threads.getThreadShell(threadId);
        if (thread === null) return null;
        const project = yield* projects.get(thread.projectId);
        if (Option.isNone(project)) return null;
        return {
          projectId: thread.projectId,
          projectRoot: project.value.workspaceRoot,
          cwd: thread.worktreePath ?? project.value.workspaceRoot,
        };
      }).pipe(Effect.orElseSucceed(() => null));

    return {
      turnStarted: turns.turnStarted,
      sealTurn: turns.sealTurn,
      ownsFileRevert: turns.isJjWorkingCopy,
      prepareFileRevert: (input) => turns.prepareRevert(input).pipe(Effect.mapError(toHookError)),
      revertFiles: (input) => turns.revert(input).pipe(Effect.mapError(toHookError)),
      // A fork of a jj thread starts in its own workspace below the parent's
      // working copy. Isolated runtimes are separate clones, so forks there
      // keep sharing the parent's directory.
      prepareForkWorkspace: (input) =>
        Effect.gen(function* () {
          const source = yield* workingCopyOf(input.sourceThreadId);
          if (source === null || !(yield* turns.isJjWorkingCopy(source.cwd))) return null;
          if ((yield* workspaces.backendFor(source.projectRoot)) !== "jj") return null;
          const base = yield* turns.forkBase(source.cwd);
          if (base === null) return null;
          const created = yield* workspaces.create({
            projectId: source.projectId,
            projectRoot: source.projectRoot,
            threadId: input.targetThreadId,
            title: input.title,
            baseRef: base,
          });
          return created.worktreePath;
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("could not create a jj workspace for the fork", { cause }).pipe(
              Effect.as(null),
            ),
          ),
        ),
      mergeBackFiles: (input) =>
        Effect.gen(function* () {
          const fork = yield* workingCopyOf(input.sourceThreadId);
          const parent = yield* workingCopyOf(input.targetThreadId);
          if (fork === null || parent === null) return;
          yield* turns
            .mergeBack({ forkCwd: fork.cwd, parentCwd: parent.cwd })
            .pipe(Effect.mapError(toHookError));
        }),
    };
  }),
).pipe(Layer.provide(Layer.merge(ProjectionStore.layer, ProjectStore.layer)));
