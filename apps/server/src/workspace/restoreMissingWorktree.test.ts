import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { deleteJjWorkspace } from "./JjWorkspaces.ts";
import { recordRemovedJjWorkspace, removedJjWorkspacesDirectory } from "./removedJjWorkspaces.ts";
import { makeRestoreMissingWorktree } from "./restoreMissingWorktree.ts";
import * as TaskFolders from "./TaskFolders.ts";

const projectId = ProjectId.make("project:app");
let projectRoot = "";

it.effect("recreates a jj workspace storage cleanup removed, on the commit it was on", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const runner = yield* ProcessRunner.make();
    const jj = (cwd: string, ...args: ReadonlyArray<string>) =>
      runner
        .run({ command: "jj", args: ["--no-pager", "--color=never", ...args], cwd })
        .pipe(
          Effect.flatMap((result) =>
            result.code === 0
              ? Effect.succeed(result.stdout.trim())
              : Effect.die(new Error(`jj ${args.join(" ")}: ${result.stderr}`)),
          ),
        );
    const repo = `${yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "restore-jj-" }))}/app`;
    projectRoot = repo;
    yield* jj("/", "git", "init", repo);
    yield* fs.writeFileString(`${repo}/README.md`, "hello\n");
    yield* jj(repo, "commit", "-m", "init");
    const root = `${config.baseDir}/workspaces/app/settled-task`;
    yield* fs.makeDirectory(`${config.baseDir}/workspaces/app`, { recursive: true });
    yield* jj(repo, "workspace", "add", "--name", "settled-task", root);
    yield* fs.writeFileString(`${root}/feature.txt`, "feature\n");
    yield* jj(root, "commit", "-m", "feature");
    const commit = yield* jj(root, "log", "--no-graph", "-r", "@-", "-T", "commit_id");
    yield* deleteJjWorkspace(root).pipe(Effect.provideService(ProcessRunner.ProcessRunner, runner));
    const records = removedJjWorkspacesDirectory(config.stateDir, yield* Path.Path);
    yield* recordRemovedJjWorkspace(records, {
      root,
      name: "settled-task",
      revisions: [commit],
    });

    const restore = yield* makeRestoreMissingWorktree;
    const result = yield* restore({
      id: ThreadId.make("thread:settled"),
      projectId,
      worktreePath: root,
      branch: null,
    });

    expect(result).toEqual({ project: { id: projectId, workspaceRoot: repo }, worktreePath: root });
    expect(yield* jj(root, "log", "--no-graph", "-r", "@-", "-T", "commit_id")).toBe(commit);
    expect(yield* fs.readFileString(`${root}/feature.txt`)).toBe("feature\n");
    expect(yield* fs.readDirectory(records)).toEqual([]);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ServerConfig.layerTest(process.cwd(), { prefix: "restore-jj-base-" }),
        ServerSettings.layerTest(),
        Layer.mock(GitWorkflowService.GitWorkflowService)({}),
        Layer.mock(TaskFolders.TaskFolders)({ find: () => Effect.succeed(null) }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.sync(() => Option.some({ id: projectId, workspaceRoot: projectRoot } as never)),
        }),
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  ),
);
