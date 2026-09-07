import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadWorkspaceService from "../workspace/ThreadWorkspaceService.ts";

export const worktreeRepairDependenciesTestLayer = Layer.mergeAll(
  Layer.mock(GitWorkflow.GitWorkflowService)({
    pruneWorktrees: () => Effect.void,
    createWorktree: () => Effect.succeed({} as never),
  }),
  Layer.mock(ProjectService.ProjectService)({
    getById: () => Effect.succeed(Option.none()),
  }),
  Layer.mock(ThreadWorkspaceService.ThreadWorkspaceService)({
    prepareWorkspace: () => Effect.die("workspace preparation is not used by this test layer"),
    resolvePrimaryCwd: () => Effect.succeed(undefined),
    deleteWorkspace: () => Effect.void,
  }),
);
