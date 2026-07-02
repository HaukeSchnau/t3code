// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { afterEach, assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ThreadWorkspaceService from "./ThreadWorkspaceService.ts";

const originalMaxBytesEnv = process.env.T3CODE_DIRECTORY_COPY_MAX_BYTES;

afterEach(() => {
  if (originalMaxBytesEnv === undefined) {
    delete process.env.T3CODE_DIRECTORY_COPY_MAX_BYTES;
  } else {
    process.env.T3CODE_DIRECTORY_COPY_MAX_BYTES = originalMaxBytesEnv;
  }
});

const makeTestLayer = (
  options: {
    readonly baseDir?: string;
    readonly processRunner?: Partial<ProcessRunner.ProcessRunner["Service"]>;
  } = {},
) =>
  ThreadWorkspaceService.layer.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      ServerConfig.layerTest(
        process.cwd(),
        options.baseDir ?? {
          prefix: "t3-thread-workspace-service-test-",
        },
      ),
    ),
    Layer.provide(Layer.mock(GitWorkflowService.GitWorkflowService)({})),
    Layer.provide(
      options.processRunner
        ? Layer.mock(ProcessRunner.ProcessRunner)({
            run: () => Effect.die("unexpected process runner invocation"),
            ...options.processRunner,
          })
        : ProcessRunner.layer,
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const layer = it.layer(Layer.fresh(makeTestLayer()));

function makeTempDir(prefix: string): string {
  return NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
}

function makeProcessOutput(
  overrides: Partial<ProcessRunner.ProcessRunOutput> = {},
): ProcessRunner.ProcessRunOutput {
  return {
    stdout: "",
    stderr: "",
    code: ChildProcessSpawner.ExitCode(0),
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    ...overrides,
  };
}

layer("ThreadWorkspaceService", (it) => {
  it.effect("persists failed directory-copy provisioning for diagnostics", () =>
    Effect.gen(function* () {
      const service = yield* ThreadWorkspaceService.ThreadWorkspaceService;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-directory-copy-failure");
      const missingSourcePath = NodePath.join(
        NodeOS.tmpdir(),
        `t3-missing-source-${process.pid}-directory-copy-failure`,
      );

      const exit = yield* Effect.exit(
        service.prepareWorkspace({
          threadId,
          kind: "directory-copy",
          roots: [
            {
              projectId: ProjectId.make("project-directory-copy-failure"),
              sourcePath: missingSourcePath,
              role: "primary",
            },
          ],
          retentionPolicy: "explicit-delete",
        }),
      );

      assert.equal(Exit.isFailure(exit), true);

      const rows = yield* sql<{
        readonly lifecycle: string;
        readonly failure_detail: string | null;
        readonly metadata_json: string;
      }>`
        SELECT
          lifecycle,
          failure_detail,
          metadata_json
        FROM projection_thread_workspaces
        WHERE id = ${`workspace:${threadId}`}
      `;

      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.lifecycle, "failed");
      assert.ok(rows[0]?.failure_detail);
      assert.match(rows[0]?.metadata_json ?? "", /"preparationStatus":"failed"/);
    }),
  );

  it.effect("refuses directory-copy when the checkout would be inside the source", () =>
    Effect.gen(function* () {
      const service = yield* ThreadWorkspaceService.ThreadWorkspaceService;
      const sql = yield* SqlClient.SqlClient;
      const config = yield* ServerConfig.ServerConfig;
      const threadId = ThreadId.make("thread-directory-copy-recursive-source");

      const exit = yield* Effect.exit(
        service.prepareWorkspace({
          threadId,
          kind: "directory-copy",
          roots: [
            {
              projectId: ProjectId.make("project-directory-copy-recursive-source"),
              sourcePath: NodePath.dirname(config.baseDir),
              role: "primary",
            },
          ],
          retentionPolicy: "explicit-delete",
        }),
      );

      assert.equal(Exit.isFailure(exit), true);

      const rows = yield* sql<{
        readonly lifecycle: string;
        readonly failure_detail: string | null;
      }>`
        SELECT lifecycle, failure_detail
        FROM projection_thread_workspaces
        WHERE id = ${`workspace:${threadId}`}
      `;

      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.lifecycle, "failed");
      assert.match(rows[0]?.failure_detail ?? "", /inside source/);
    }),
  );

  it.effect("creates a small directory-copy workspace with the async copy strategy", () =>
    Effect.gen(function* () {
      const service = yield* ThreadWorkspaceService.ThreadWorkspaceService;
      const sql = yield* SqlClient.SqlClient;
      const hostPlatform = yield* HostProcessPlatform;
      const sourcePath = makeTempDir("t3-directory-copy-small-source-");
      NodeFS.writeFileSync(NodePath.join(sourcePath, "file.txt"), "copied");
      const threadId = ThreadId.make("thread-directory-copy-small-source");

      const prepared = yield* service.prepareWorkspace({
        threadId,
        kind: "directory-copy",
        roots: [
          {
            projectId: ProjectId.make("project-directory-copy-small-source"),
            sourcePath,
            role: "primary",
          },
        ],
        retentionPolicy: "explicit-delete",
      });

      assert.equal(
        NodeFS.readFileSync(NodePath.join(prepared.primaryCwd, "file.txt"), "utf8"),
        "copied",
      );

      const rows = yield* sql<{ readonly lifecycle: string; readonly metadata_json: string }>`
        SELECT lifecycle, metadata_json
        FROM projection_thread_workspaces
        WHERE id = ${`workspace:${threadId}`}
      `;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.lifecycle, "active");
      assert.match(rows[0]?.metadata_json ?? "", /"preparationStatus":"ready"/);
      assert.match(
        rows[0]?.metadata_json ?? "",
        hostPlatform === "darwin"
          ? /"copyStrategy":"copy-on-write"/
          : /"copyStrategy":"recursive-copy"/,
      );
    }),
  );

  it.effect("refuses directory-copy sources over the configured size limit", () =>
    Effect.gen(function* () {
      process.env.T3CODE_DIRECTORY_COPY_MAX_BYTES = "1";
      const sourcePath = makeTempDir("t3-directory-copy-large-source-");
      NodeFS.writeFileSync(NodePath.join(sourcePath, "file.txt"), "too large");
      const baseDir = makeTempDir("t3-directory-copy-large-base-");

      yield* Effect.gen(function* () {
        const service = yield* ThreadWorkspaceService.ThreadWorkspaceService;
        const exit = yield* Effect.exit(
          service.prepareWorkspace({
            threadId: ThreadId.make("thread-directory-copy-large-source"),
            kind: "directory-copy",
            roots: [
              {
                projectId: ProjectId.make("project-directory-copy-large-source"),
                sourcePath,
                role: "primary",
              },
            ],
            retentionPolicy: "explicit-delete",
          }),
        );

        assert.equal(Exit.isFailure(exit), true);

        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          readonly lifecycle: string;
          readonly failure_detail: string | null;
        }>`
          SELECT lifecycle, failure_detail
          FROM projection_thread_workspaces
          WHERE id = ${"workspace:thread-directory-copy-large-source"}
        `;
        assert.equal(rows.length, 1);
        assert.equal(rows[0]?.lifecycle, "failed");
        assert.match(rows[0]?.failure_detail ?? "", /exceeding/);
      }).pipe(
        Effect.provide(
          makeTestLayer({
            baseDir,
            processRunner: {
              run: (input) =>
                input.command === "du"
                  ? Effect.succeed(makeProcessOutput({ stdout: `2\t${sourcePath}\n` }))
                  : Effect.die("copy should not run after size preflight refusal"),
            },
          }),
        ),
      );
    }),
  );

  it.effect("persists copying state while async directory-copy provisioning is running", () =>
    Effect.gen(function* () {
      const sourcePath = makeTempDir("t3-directory-copy-async-source-");
      NodeFS.writeFileSync(NodePath.join(sourcePath, "file.txt"), "contents");
      const baseDir = makeTempDir("t3-directory-copy-async-base-");
      const copyStarted = yield* Deferred.make<ProcessRunner.ProcessRunInput, never>();
      const releaseCopy = yield* Deferred.make<void, never>();
      const threadId = ThreadId.make("thread-directory-copy-copying-state");

      const effect = Effect.gen(function* () {
        const service = yield* ThreadWorkspaceService.ThreadWorkspaceService;
        const sql = yield* SqlClient.SqlClient;
        const hostPlatform = yield* HostProcessPlatform;
        const fiber = yield* service
          .prepareWorkspace({
            threadId,
            kind: "directory-copy",
            roots: [
              {
                projectId: ProjectId.make("project-directory-copy-copying-state"),
                sourcePath,
                role: "primary",
              },
            ],
            retentionPolicy: "explicit-delete",
          })
          .pipe(Effect.forkScoped);

        const copyInput = yield* Deferred.await(copyStarted);
        const rows = yield* sql<{
          readonly lifecycle: string;
          readonly metadata_json: string;
        }>`
          SELECT lifecycle, metadata_json
          FROM projection_thread_workspaces
          WHERE id = ${`workspace:${threadId}`}
        `;

        assert.equal(rows.length, 1);
        assert.equal(rows[0]?.lifecycle, "preparing");
        assert.match(rows[0]?.metadata_json ?? "", /"preparationStatus":"copying"/);
        assert.deepEqual(copyInput.args.slice(0, 1), hostPlatform === "darwin" ? ["-cR"] : ["-R"]);

        yield* Deferred.succeed(releaseCopy, undefined);
        const prepared = yield* Fiber.join(fiber);
        assert.equal(prepared.workspace.lifecycle, "active");
      }).pipe(
        Effect.provide(
          makeTestLayer({
            baseDir,
            processRunner: {
              run: (input) => {
                if (input.command === "du") {
                  return Effect.succeed(makeProcessOutput({ stdout: `1\t${sourcePath}\n` }));
                }
                return Deferred.succeed(copyStarted, input).pipe(
                  Effect.andThen(Deferred.await(releaseCopy)),
                  Effect.as(makeProcessOutput()),
                );
              },
            },
          }),
        ),
      );

      yield* effect;
    }),
  );
});
