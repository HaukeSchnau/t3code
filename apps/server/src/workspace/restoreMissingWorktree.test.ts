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
import {
  recordRemovedJjWorkspace,
  removedJjWorkspaceName,
  removedJjWorkspacesDirectory,
} from "./removedJjWorkspaces.ts";
import { makeRestoreMissingWorktree } from "./restoreMissingWorktree.ts";
import * as TaskFolders from "./TaskFolders.ts";

const projectId = ProjectId.make("project:app");
let projectRoot = "";

it.effect.each([
  { name: "its name is free", nameTaken: false, symlinked: false },
  { name: "another project's workspace took its name", nameTaken: true, symlinked: false },
  { name: "the workspaces folder is a symlink", nameTaken: false, symlinked: true },
])(
  "recreates a jj workspace storage cleanup removed, on its commit, when $name",
  ({ nameTaken, symlinked }) =>
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
      if (symlinked) {
        const target = yield* fs.makeTempDirectoryScoped({ prefix: "restore-jj-workspaces-" });
        yield* fs.symlink(target, `${config.baseDir}/workspaces`);
      }
      const root = `${config.baseDir}/workspaces/app/settled-task`;
      yield* fs.makeDirectory(`${config.baseDir}/workspaces/app`, { recursive: true });
      yield* jj(repo, "workspace", "add", "--name", "settled-task", root);
      yield* fs.writeFileString(`${root}/feature.txt`, "feature\n");
      yield* jj(root, "commit", "-m", "feature");
      const commit = yield* jj(root, "log", "--no-graph", "-r", "@-", "-T", "commit_id");
      yield* deleteJjWorkspace(root).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
      );
      const records = removedJjWorkspacesDirectory(config.stateDir, yield* Path.Path);
      const elsewhere = `${config.baseDir}/workspaces/pkg/settled-task`;
      if (nameTaken) {
        yield* fs.makeDirectory(`${config.baseDir}/workspaces/pkg`, { recursive: true });
        yield* jj(repo, "workspace", "add", "--name", "settled-task", elsewhere);
      }
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

      expect(result).toEqual({
        project: { id: projectId, workspaceRoot: repo },
        worktreePath: root,
      });
      expect(yield* jj(root, "log", "--no-graph", "-r", "@-", "-T", "commit_id")).toBe(commit);
      expect(yield* fs.readFileString(`${root}/feature.txt`)).toBe("feature\n");
      expect(yield* fs.readDirectory(records)).toEqual([]);
      const names = yield* jj(repo, "workspace", "list", "-T", 'name ++ " " ++ root ++ "\\n"');
      const restored = removedJjWorkspaceName({ root, name: "settled-task", revisions: [] });
      expect(names.split("\n").sort()).toEqual([
        `default ${repo}`,
        ...(nameTaken ? [`settled-task ${elsewhere}`] : []),
        `${restored} ${yield* fs.realPath(root)}`,
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerConfig.layerTest(process.cwd(), { prefix: "restore-jj-base-" }),
          ServerSettings.layerTest(),
          Layer.mock(GitWorkflowService.GitWorkflowService)({}),
          Layer.mock(TaskFolders.TaskFolders)({ find: () => Effect.succeed(null) }),
          Layer.mock(ProjectService.ProjectService)({
            getById: () =>
              Effect.sync(() =>
                Option.some({ id: projectId, workspaceRoot: projectRoot } as never),
              ),
          }),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    ),
);
