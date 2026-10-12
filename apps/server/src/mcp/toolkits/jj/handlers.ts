import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as JjStatusReader from "../../../jj/JjStatusReader.ts";
import * as JjThreadWork from "../../../jj/JjThreadWork.ts";
import * as JjWorkflow from "../../../jj/JjWorkflow.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { JjToolkit } from "./tools.ts";

/** The calling thread's working copy: its worktree, or its project's checkout. */
const callerWorkingCopy = Effect.gen(function* () {
  const context = yield* McpInvocationContext.McpInvocationContext;
  if (!context.capabilities.has("worktree")) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential cannot use version control.",
    });
  }
  const { caller } = yield* readCaller();
  const projects = yield* Project.ProjectService;
  const project = yield* projects.getById(caller.projectId).pipe(Effect.mapError(unavailable));
  if (Option.isNone(project)) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "The project was not found.",
    });
  }
  return { threadId: caller.id, cwd: caller.worktreePath ?? project.value.workspaceRoot };
});

const handlers = {
  t3_jj_status: () =>
    Effect.gen(function* () {
      const { cwd } = yield* callerWorkingCopy;
      const reader = yield* JjStatusReader.JjStatusReader;
      return yield* reader.read(cwd);
    }),
  t3_jj_action: (input) =>
    Effect.gen(function* () {
      const { cwd, threadId } = yield* callerWorkingCopy;
      const workflow = yield* JjWorkflow.JjWorkflow;
      return yield* workflow
        .runAction({ cwd, threadId, action: input.action })
        .pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
          ),
        );
    }),
  t3_jj_thread_work: () =>
    Effect.gen(function* () {
      const { caller } = yield* readCaller();
      const work = yield* JjThreadWork.JjThreadWork;
      return { repositories: yield* work.find(caller.id) };
    }),
} satisfies Parameters<typeof JjToolkit.toLayer>[0];

export const JjToolkitHandlersLive = JjToolkit.toLayer(handlers);
