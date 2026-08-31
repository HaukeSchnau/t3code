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
    readonly platform?: NodeJS.Platform;
    readonly processRunner?: Partial<ProcessRunner.ProcessRunner["Service"]>;
    readonly gitWorkflow?: Partial<GitWorkflowService.GitWorkflowService["Service"]>;
  } = {},
) => {
  const layer = ThreadWorkspaceService.layer.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      ServerConfig.layerTest(
        process.cwd(),
        options.baseDir ?? {
          prefix: "t3-thread-workspace-service-test-",
        },
      ),
    ),
    Layer.provide(
      Layer.mock(GitWorkflowService.GitWorkflowService)({
        ...options.gitWorkflow,
      }),
    ),
    Layer.provide(
      options.processRunner
        ? Layer.mock(ProcessRunner.ProcessRunner)({
            run: () => Effect.die(new Error("unexpected process runner invocation")),
            ...options.processRunner,
          })
        : ProcessRunner.layer,
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  return options.platform
    ? layer.pipe(Layer.provideMerge(Layer.succeed(HostProcessPlatform, options.platform)))
    : layer;
};

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
    stdoutInvalidUtf8: false,
    stderrInvalidUtf8: false,
    ...overrides,
  };
}

layer("ThreadWorkspaceService", (it) => {
  it("builds stable semantic workspace names for paths and URLs", () => {
    const threadId = ThreadId.make("4d44933151b04b2088313360ae3f5157");
    const name = ThreadWorkspaceService.__testing.workspaceName({
      semanticSeed: "Generate fitting workspace URLs",
      fallbackSeed: "studienbuch",
      threadId,
    });

    assert.match(name, /^generate-fitting-workspace-urls-[a-f0-9]{6}$/);
    assert.equal(name.length <= 48, true);
    assert.equal(
      ThreadWorkspaceService.__testing.workspaceName({
        semanticSeed: "Generate fitting workspace URLs",
        fallbackSeed: "studienbuch",
        threadId,
      }),
      name,
    );
  });

  it("normalizes international and oversized workspace titles", () => {
    const name = ThreadWorkspaceService.__testing.workspaceName({
      semanticSeed:
        "Übermäßig große Änderung für langlebige, projektübergreifende Entwicklungsumgebungen",
      fallbackSeed: "studienbuch",
      threadId: ThreadId.make("thread-semantic-workspace-name"),
    });

    assert.match(name, /^ubermassig-grosse-anderung-fur-langlebige-[a-f0-9]{6}$/);
    assert.equal(name.length, 48);
  });

  it("falls back to the project name when no semantic title is available", () => {
    assert.match(
      ThreadWorkspaceService.__testing.workspaceName({
        semanticSeed: undefined,
        fallbackSeed: "Studienbuch",
        threadId: ThreadId.make("thread-workspace-fallback"),
      }),
      /^studienbuch-[a-f0-9]{6}$/,
    );
  });

  it.effect("reconciles an interrupted deterministic git workspace before retry", () =>
    Effect.gen(function* () {
      const baseDir = makeTempDir("t3-workspace-restart-base-");
      const sourcePath = makeTempDir("t3-workspace-restart-source-");
      const threadId = ThreadId.make("thread-git-workspace-restart");
      let createCount = 0;
      let removeCount = 0;

      yield* Effect.gen(function* () {
        const service = yield* ThreadWorkspaceService.ThreadWorkspaceService;
        const sql = yield* SqlClient.SqlClient;
        const input = {
          threadId,
          kind: "git-detached" as const,
          roots: [
            {
              projectId: ProjectId.make("project-git-workspace-restart"),
              sourcePath,
              role: "primary" as const,
              baseRevision: "main",
            },
          ],
          retentionPolicy: "explicit-delete" as const,
        };

        const interrupted = yield* service.prepareWorkspace(input).pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(interrupted));

        const resumed = yield* service.prepareWorkspace(input);
        const replayed = yield* service.prepareWorkspace(input);
        const rows = yield* sql<{
          readonly id: string;
          readonly lifecycle: string;
        }>`SELECT id, lifecycle FROM projection_thread_workspaces WHERE created_for_thread_id = ${threadId}`;

        assert.equal(createCount, 2);
        assert.equal(removeCount, 1);
        assert.equal(rows.length, 1);
        assert.deepEqual(rows[0], {
          id: `workspace:${threadId}`,
          lifecycle: "active",
        });
        assert.equal(resumed.workspace.id, `workspace:${threadId}`);
        assert.equal(replayed.workspace.id, resumed.workspace.id);
      }).pipe(
        Effect.provide(
          makeTestLayer({
            baseDir,
            gitWorkflow: {
              createWorktree: ({ path }) =>
                Effect.sync(() => {
                  assert.isNotNull(path);
                  createCount += 1;
                  NodeFS.mkdirSync(path, { recursive: true });
                  if (createCount === 1) {
                    throw new Error("simulated crash after git worktree creation");
                  }
                  return { worktree: { refName: "main", path } };
                }),
              removeWorktree: () =>
                Effect.sync(() => {
                  removeCount += 1;
                }),
            },
          }),
        ),
      );
    }),
  );

  it("recognizes Linux BTRFS reflink directory-copy capabilities", () => {
    const destinationFileSystemType = ThreadWorkspaceService.__testing.fileSystemTypeFromStatfsType(
      ThreadWorkspaceService.__testing.BTRFS_STATFS_TYPE,
      "linux",
    );

    const copyOnWriteKind = ThreadWorkspaceService.__testing.copyOnWriteKindForCapabilities({
      platform: "linux",
      sourceDevice: 49,
      destinationDevice: 49,
      sourceFileSystemType: destinationFileSystemType,
      destinationFileSystemType,
    });

    assert.equal(destinationFileSystemType, "btrfs");
    assert.equal(copyOnWriteKind, "btrfs-reflink");
    assert.deepEqual(
      ThreadWorkspaceService.__testing.primaryDirectoryCopyCommand(
        "/home/haukeschnau/Code",
        "/home/haukeschnau/.t3/workspaces/Code/thread",
        copyOnWriteKind,
      ),
      {
        command: "cp",
        args: [
          "-a",
          "--reflink=always",
          "/home/haukeschnau/Code",
          "/home/haukeschnau/.t3/workspaces/Code/thread",
        ],
        strategy: "copy-on-write",
      },
    );
  });

  it("allows BTRFS reflink copy-on-write across subvolume devices", () => {
    const copyOnWriteKind = ThreadWorkspaceService.__testing.copyOnWriteKindForCapabilities({
      platform: "linux",
      sourceDevice: 37,
      destinationDevice: 49,
      sourceFileSystemType: "btrfs",
      destinationFileSystemType: "btrfs",
    });

    assert.equal(copyOnWriteKind, "btrfs-reflink");
    assert.deepEqual(
      ThreadWorkspaceService.__testing.primaryDirectoryCopyCommand(
        "/srv/source",
        "/home/haukeschnau/.t3/workspaces/source/thread",
        copyOnWriteKind,
      ),
      {
        command: "cp",
        args: [
          "-a",
          "--reflink=always",
          "/srv/source",
          "/home/haukeschnau/.t3/workspaces/source/thread",
        ],
        strategy: "copy-on-write",
      },
    );
  });

  it("does not use BTRFS reflink copy-on-write when only the destination is BTRFS", () => {
    const copyOnWriteKind = ThreadWorkspaceService.__testing.copyOnWriteKindForCapabilities({
      platform: "linux",
      sourceDevice: 37,
      destinationDevice: 49,
      sourceFileSystemType: "type:ef53",
      destinationFileSystemType: "btrfs",
    });

    assert.equal(copyOnWriteKind, null);
    assert.deepEqual(
      ThreadWorkspaceService.__testing.primaryDirectoryCopyCommand(
        "/mnt/ext4/source",
        "/home/haukeschnau/.t3/workspaces/source/thread",
        copyOnWriteKind,
      ),
      {
        command: "cp",
        args: ["-R", "/mnt/ext4/source", "/home/haukeschnau/.t3/workspaces/source/thread"],
        strategy: "recursive-copy",
      },
    );
  });

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
      const metadataJson = rows[0]?.metadata_json ?? "";
      assert.match(metadataJson, /"preparationStatus":"ready"/);
      assert.match(
        metadataJson,
        metadataJson.includes('"copyOnWriteSupported":true')
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
            platform: "freebsd",
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

  it.effect("allows APFS copy-on-write sources over the configured size limit", () =>
    Effect.gen(function* () {
      const hostPlatform = yield* HostProcessPlatform;
      if (hostPlatform !== "darwin") {
        return;
      }
      process.env.T3CODE_DIRECTORY_COPY_MAX_BYTES = "1";
      const sourcePath = makeTempDir("t3-directory-copy-apfs-large-source-");
      NodeFS.writeFileSync(NodePath.join(sourcePath, "file.txt"), "too large for configured cap");
      const baseDir = makeTempDir("t3-directory-copy-apfs-large-base-");

      yield* Effect.gen(function* () {
        const service = yield* ThreadWorkspaceService.ThreadWorkspaceService;
        const sql = yield* SqlClient.SqlClient;
        const prepared = yield* service.prepareWorkspace({
          threadId: ThreadId.make("thread-directory-copy-apfs-large-source"),
          kind: "directory-copy",
          roots: [
            {
              projectId: ProjectId.make("project-directory-copy-apfs-large-source"),
              sourcePath,
              role: "primary",
            },
          ],
          retentionPolicy: "explicit-delete",
        });

        assert.equal(
          NodeFS.readFileSync(NodePath.join(prepared.primaryCwd, "file.txt"), "utf8"),
          "too large for configured cap",
        );

        const rows = yield* sql<{ readonly metadata_json: string }>`
          SELECT metadata_json
          FROM projection_thread_workspaces
          WHERE id = ${"workspace:thread-directory-copy-apfs-large-source"}
        `;
        assert.equal(rows.length, 1);
        assert.match(rows[0]?.metadata_json ?? "", /"diskSpacePolicy":"copy-on-write-guarded"/);
        assert.match(rows[0]?.metadata_json ?? "", /"copyOnWriteSupported":true/);
      }).pipe(Effect.provide(makeTestLayer({ baseDir })));
    }),
  );

  it.effect("does not fall back to full copy when APFS clone fails for an oversized source", () =>
    Effect.gen(function* () {
      const hostPlatform = yield* HostProcessPlatform;
      if (hostPlatform !== "darwin") {
        return;
      }
      process.env.T3CODE_DIRECTORY_COPY_MAX_BYTES = "1";
      const sourcePath = makeTempDir("t3-directory-copy-apfs-fallback-source-");
      const blockedFile = NodePath.join(sourcePath, "blocked.txt");
      NodeFS.writeFileSync(blockedFile, "blocked");
      NodeFS.chmodSync(blockedFile, 0o000);
      const baseDir = makeTempDir("t3-directory-copy-apfs-fallback-base-");

      yield* Effect.gen(function* () {
        const service = yield* ThreadWorkspaceService.ThreadWorkspaceService;
        const exit = yield* Effect.exit(
          service.prepareWorkspace({
            threadId: ThreadId.make("thread-directory-copy-apfs-unsafe-fallback"),
            kind: "directory-copy",
            roots: [
              {
                projectId: ProjectId.make("project-directory-copy-apfs-unsafe-fallback"),
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
          WHERE id = ${"workspace:thread-directory-copy-apfs-unsafe-fallback"}
        `;
        assert.equal(rows.length, 1);
        assert.equal(rows[0]?.lifecycle, "failed");
        assert.match(rows[0]?.failure_detail ?? "", /full-copy fallback is not safe/);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => NodeFS.chmodSync(blockedFile, 0o600)).pipe(Effect.ignore),
        ),
        Effect.provide(makeTestLayer({ baseDir })),
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
            platform: "freebsd",
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

  it.effect("deletes directory-copy workspaces containing read-only directories", () =>
    Effect.gen(function* () {
      const service = yield* ThreadWorkspaceService.ThreadWorkspaceService;
      const sourcePath = makeTempDir("t3-directory-copy-readonly-source-");
      const readOnlyDir = NodePath.join(sourcePath, "readonly");
      NodeFS.mkdirSync(readOnlyDir);
      NodeFS.writeFileSync(NodePath.join(readOnlyDir, "file.txt"), "readonly");
      NodeFS.chmodSync(readOnlyDir, 0o500);
      const prepared = yield* service.prepareWorkspace({
        threadId: ThreadId.make("thread-directory-copy-readonly-delete"),
        kind: "directory-copy",
        roots: [
          {
            projectId: ProjectId.make("project-directory-copy-readonly-delete"),
            sourcePath,
            role: "primary",
          },
        ],
        retentionPolicy: "explicit-delete",
      });

      const checkoutPath = prepared.primaryCwd;
      assert.equal(NodeFS.existsSync(checkoutPath), true);
      yield* service.deleteWorkspace({ workspaceId: prepared.workspace.id, force: true });
      assert.equal(NodeFS.existsSync(checkoutPath), false);

      NodeFS.chmodSync(readOnlyDir, 0o700);
    }),
  );
});
