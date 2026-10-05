import type { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";

/**
 * Lets MCP tools address any thread by id, whatever project the caller is in
 * (patches/cross-project-orchestration.md). Each `{ projectId, threadId }`
 * request runs against the target thread's own project, so the wrapped service
 * still rejects deleted threads. `server.ts` provides this only to the MCP
 * routes; every other consumer keeps upstream's project scoping.
 */
export const layer = Layer.effect(
  ThreadManagementService.ThreadManagementService,
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const projects = yield* ProjectService.ProjectService;

    const inThreadProject = <
      Input extends { readonly projectId: ProjectId; readonly threadId: ThreadId },
    >(
      input: Input,
    ) =>
      threads.getThreadShell(input.threadId).pipe(
        Effect.mapError(
          (cause) =>
            new ThreadManagementService.ThreadManagementProjectionLoadError({
              projectId: input.projectId,
              threadId: input.threadId,
              cause,
            }),
        ),
        Effect.map((shell): Input =>
          shell === null ? input : { ...input, projectId: shell.projectId },
        ),
      );

    const requireProject = (projectId: ProjectId) =>
      projects.getById(projectId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new ProjectService.ProjectNotFoundError({ projectId })),
            onSome: () => Effect.void,
          }),
        ),
        Effect.mapError(
          (cause) =>
            new ThreadManagementService.ThreadManagementProjectThreadsListError({
              projectId,
              cause,
            }),
        ),
      );

    return ThreadManagementService.ThreadManagementService.of({
      ...threads,
      getProjectThreadRecords: (input, fields, filter) =>
        inThreadProject(input).pipe(
          Effect.flatMap((scoped) => threads.getProjectThreadRecords(scoped, fields, filter)),
        ),
      getProjectThread: (input) =>
        inThreadProject(input).pipe(Effect.flatMap(threads.getProjectThread)),
      sendToThread: (input) => inThreadProject(input).pipe(Effect.flatMap(threads.sendToThread)),
      waitForThread: (input) => inThreadProject(input).pipe(Effect.flatMap(threads.waitForThread)),
      interruptThread: (input) =>
        inThreadProject(input).pipe(Effect.flatMap(threads.interruptThread)),
      listProjectThreads: (input) =>
        requireProject(input.projectId).pipe(Effect.andThen(threads.listProjectThreads(input))),
    });
  }),
);
