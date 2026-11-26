import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ThreadId, type HostResourcesSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";
import { vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as LocalPlacement from "./LocalPlacement.ts";

const idle: HostResourcesSnapshot = {
  sampledAt: 0,
  cpuUtilization: 0,
  cpuCount: 16,
  availableMemoryBytes: 64 * 1024 ** 3,
  totalMemoryBytes: 64 * 1024 ** 3,
  loadAverage: 0,
};

interface Setup {
  /** Each call to `read` takes the next entry; the last one repeats. `"fail"` dies. */
  readonly resources?: ReadonlyArray<HostResourcesSnapshot | "fail">;
  readonly waitingSince?: string | null;
  readonly endWaitFails?: boolean;
}

const layerFor = (setup: Setup, endedWaits: Ref.Ref<number>, reads: Ref.Ref<number>) =>
  LocalPlacement.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ServerSettings.layerTest({ placementAgentLimit: 1 }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getDescriptor: Effect.succeed({
            environmentId: EnvironmentId.make("env-here"),
            label: "here",
          } as never),
        }),
        Layer.mock(HostResources.HostResources)({
          read: Ref.getAndUpdate(reads, (count) => count + 1).pipe(
            Effect.flatMap((count) => {
              const resources = setup.resources ?? [idle];
              const next = resources[Math.min(count, resources.length - 1)];
              return next === "fail" || next === undefined
                ? Effect.die("no host resources")
                : Effect.succeed(next);
            }),
          ),
        }),
        Layer.mock(ProjectService.ProjectService)({
          listPage: () => Effect.succeed({ projects: [], nextCursor: null } as never),
          getByWorkspaceRoot: () => Effect.succeedNone,
          create: (input) => Effect.succeed({ id: input.projectId } as never),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        NodeCrypto.layer,
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () =>
            Effect.succeed({
              placement: {
                waitingSince:
                  setup.waitingSince === undefined
                    ? "2026-11-24T12:00:00.000Z"
                    : setup.waitingSince,
              },
            } as never),
          dispatch: () =>
            setup.endWaitFails === true
              ? Effect.fail("not committed" as never)
              : Ref.update(endedWaits, (count) => count + 1).pipe(Effect.as({} as never)),
        }),
      ),
    ),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-local-placement-" })),
    Layer.provideMerge(NodeServices.layer),
  );

const withPlacement = <A, E>(
  setup: Setup,
  body: (
    placement: LocalPlacement.LocalPlacement["Service"],
    state: { readonly endedWaits: Ref.Ref<number>; readonly reads: Ref.Ref<number> },
  ) => Effect.Effect<A, E, Layer.Success<ReturnType<typeof layerFor>>>,
) =>
  Effect.gen(function* () {
    const endedWaits = yield* Ref.make(0);
    const reads = yield* Ref.make(0);
    return yield* Effect.gen(function* () {
      return yield* body(yield* LocalPlacement.LocalPlacement, { endedWaits, reads });
    }).pipe(Effect.provide(layerFor(setup, endedWaits, reads)));
  });

const insertRun = (threadId: string, ordinal: number, status: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES (${`${threadId}-run-${ordinal}`}, ${threadId}, ${ordinal}, 'codex', ${status},
        '2026-11-24T12:00:00.000Z', '{}')
    `;
  });

it.effect("counts a preparing run the room check read, not a waiter that joined after it", () =>
  withPlacement({}, (placement) =>
    Effect.gen(function* () {
      yield* insertRun("thread-starting", 1, "preparing");
      // A waiter whose run is not in the table yet must not cancel out the preparing one.
      const waiter = yield* placement
        .awaitRoom(ThreadId.make("thread-waiting"), 0)
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const load = yield* placement.report();
      assert.equal(load.launchesInFlight, 1);
      assert.equal(load.waiting, 1);
      yield* Fiber.interrupt(waiter);
    }),
  ),
);

it.effect("lets a thread start when start anyway ended its wait before it registered", () =>
  withPlacement({ waitingSince: null }, (placement) =>
    Effect.gen(function* () {
      yield* insertRun("thread-busy", 1, "running");
      const waiter = yield* placement
        .awaitRoom(ThreadId.make("thread-started"), 0)
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      yield* Fiber.join(waiter);
    }),
  ),
);

it.effect("keeps a thread waiting while the end of its wait cannot be recorded", () =>
  withPlacement({ endWaitFails: true }, (placement) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-waiting");
      const waiter = yield* placement.awaitRoom(threadId, 0).pipe(Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      assert.isUndefined(waiter.pollUnsafe());
      const startNow = yield* placement.startNow(threadId).pipe(Effect.flip);
      assert.equal(startNow._tag, "PlacementError");
      assert.isUndefined(waiter.pollUnsafe());
      yield* Fiber.interrupt(waiter);
    }),
  ),
);

it.effect("keeps checking for room after a load read fails", () =>
  withPlacement({ resources: ["fail", idle] }, (placement, { endedWaits, reads }) =>
    Effect.gen(function* () {
      const waiter = yield* placement
        .awaitRoom(ThreadId.make("thread-waiting"), 0)
        .pipe(Effect.forkChild);
      // The first scheduled check reads nothing and must not end the checks.
      yield* TestClock.adjust("10 seconds");
      assert.isAbove(yield* Ref.get(reads), 1);
      yield* Fiber.join(waiter);
      assert.equal(yield* Ref.get(endedWaits), 1);
    }),
  ),
);

it.effect("reports updating while a release keeps asking, and takes work once it stops", () =>
  withPlacement({}, (placement) =>
    Effect.gen(function* () {
      assert.isFalse((yield* placement.report()).updating);
      yield* placement.drain;
      yield* TestClock.adjust("14 minutes");
      assert.isTrue((yield* placement.report()).updating);
      // Each retry of the waiting release renews the drain.
      yield* placement.drain;
      yield* TestClock.adjust("14 minutes");
      assert.isTrue((yield* placement.report()).updating);
      yield* TestClock.adjust("1 minute");
      assert.isFalse((yield* placement.report()).updating);
    }),
  ),
);

it.effect("keeps a thread waiting while a release waits for the host", () =>
  withPlacement({}, (placement, { endedWaits }) =>
    Effect.gen(function* () {
      yield* placement.drain;
      const waiter = yield* placement
        .awaitRoom(ThreadId.make("thread-waiting"), 0)
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("10 minutes");
      assert.isUndefined(waiter.pollUnsafe());
      yield* TestClock.adjust("6 minutes");
      yield* Fiber.join(waiter);
      assert.equal(yield* Ref.get(endedWaits), 1);
    }),
  ),
);

it.effect("copies a peer's files only inside the new clone, never into .git", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const root = "/clones/repo";
    assert.equal(LocalPlacement.pathInside(path, root, ".env"), "/clones/repo/.env");
    assert.equal(
      LocalPlacement.pathInside(path, root, "apps/web/.env.local"),
      "/clones/repo/apps/web/.env.local",
    );
    // A folder whose name starts with two dots is still inside.
    assert.equal(
      LocalPlacement.pathInside(path, root, "..cache/.env"),
      "/clones/repo/..cache/.env",
    );
    for (const escape of ["../.env", "/etc/passwd", "apps/../../.env", ".git/config", ".", ""]) {
      assert.isUndefined(LocalPlacement.pathInside(path, root, escape), escape);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

/** A repository with a committed `linked` symlink to a folder outside it. */
const repositoryWithOutsideLink = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "t3-placement-clone-" });
  const source = path.join(scratch, "source");
  const outside = path.join(scratch, "outside");
  yield* fs.makeDirectory(outside);
  yield* fs.makeDirectory(source);
  yield* fs.symlink(outside, path.join(source, "linked"));
  yield* fs.writeFileString(path.join(source, ".env"), "TRACKED=1");
  yield* fs.writeFileString(path.join(source, ".env.Shared"), "TRACKED=1");
  // The repository's own rules can unignore an env file; such a file must never be copied in.
  yield* fs.writeFileString(path.join(source, ".gitignore"), "!.env.unignored\n.env.dev\n");
  const runner = yield* ProcessRunner.ProcessRunner;
  const git = (...args: ReadonlyArray<string>) =>
    runner.run({ command: "git", args: ["-C", source, ...args] }).pipe(
      Effect.orDie,
      Effect.flatMap((result) =>
        result.code === 0 ? Effect.void : Effect.die(`git ${args[0]} failed: ${result.stderr}`),
      ),
    );
  yield* git("init", "-q");
  yield* git("add", "-f", "linked", ".env", ".env.Shared", ".gitignore");
  yield* git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.com",
    "-c",
    "commit.gpgSign=false",
    "commit",
    "-qm",
    "init",
  );
  return { source, outside };
}).pipe(Effect.provide(ProcessRunner.layer));

it.effect("refuses a project folder that a symlink in the clone leads outside of it", () =>
  withPlacement({}, (placement) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { source, outside } = yield* repositoryWithOutsideLink;
      const result = yield* placement
        .hydrate({
          repository: "example.com/acme/linked",
          path: "linked",
          remoteUrl: source,
          title: "linked",
          files: [{ path: "nested/.env", contents: Buffer.from("SECRET=1").toString("base64") }],
        })
        .pipe(Effect.flip);
      // Refused before the clone is moved into place, so no later launch reuses it.
      assert.equal(result.message, "example.com/acme/linked has no folder linked.");
      const { baseDir } = yield* ServerConfig.ServerConfig;
      assert.isFalse(
        yield* fs.exists(path.join(baseDir, "placement", "repos", "example.com", "acme", "linked")),
      );
      assert.deepEqual(yield* fs.readDirectory(outside), []);
      assert.isFalse(yield* fs.exists(path.join(outside, "nested")));
    }).pipe(Effect.scoped),
  ),
);

it.effect("does not take a folder that is not a clone of the repository as one", () =>
  withPlacement({}, (placement) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { baseDir } = yield* ServerConfig.ServerConfig;
      yield* fs.makeDirectory(
        path.join(baseDir, "placement", "repos", "example.com", "acme", "app"),
        {
          recursive: true,
        },
      );
      const result = yield* placement
        .hydrate({
          repository: "example.com/acme/app",
          path: "",
          remoteUrl: "https://example.com/acme/app.git",
          title: "app",
          files: [],
        })
        .pipe(Effect.flip);
      assert.equal(
        result.message,
        "This machine's folder for example.com/acme/app is not a clone of it.",
      );
    }),
  ),
);

it.effect("does not take a linked worktree, whose git folder is elsewhere, as a clone", () =>
  withPlacement({}, (placement) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { source } = yield* repositoryWithOutsideLink;
      const { baseDir } = yield* ServerConfig.ServerConfig;
      const remoteUrl = "https://example.com/acme/worktree.git";
      const repoRoot = path.join(baseDir, "placement", "repos", "example.com", "acme", "worktree");
      const runner = yield* ProcessRunner.ProcessRunner;
      const git = (...args: ReadonlyArray<string>) =>
        runner.run({ command: "git", args: ["-C", source, ...args] }).pipe(
          Effect.orDie,
          Effect.flatMap((result) =>
            result.code === 0 ? Effect.void : Effect.die(`git ${args[0]} failed: ${result.stderr}`),
          ),
        );
      yield* git("remote", "add", "origin", remoteUrl);
      yield* git("worktree", "add", "-q", "--detach", repoRoot);
      const result = yield* placement
        .hydrate({
          repository: "example.com/acme/worktree",
          path: "",
          remoteUrl,
          title: "w",
          files: [],
        })
        .pipe(Effect.flip);
      assert.equal(
        result.message,
        "This machine's folder for example.com/acme/worktree is not a clone of it.",
      );
    }).pipe(Effect.scoped, Effect.provide(ProcessRunner.layer)),
  ),
);

it.effect("does not take a folder whose .git is a symlink to another repository", () =>
  withPlacement({}, (placement) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { source } = yield* repositoryWithOutsideLink;
      const { baseDir } = yield* ServerConfig.ServerConfig;
      const remoteUrl = "https://example.com/acme/linkedgit.git";
      const runner = yield* ProcessRunner.ProcessRunner;
      const git = (...args: ReadonlyArray<string>) =>
        runner.run({ command: "git", args }).pipe(
          Effect.orDie,
          Effect.flatMap((result) =>
            result.code === 0 ? Effect.void : Effect.die(`git ${args[0]} failed: ${result.stderr}`),
          ),
        );
      yield* git("-C", source, "remote", "add", "origin", remoteUrl);
      const repoRoot = path.join(baseDir, "placement", "repos", "example.com", "acme", "linkedgit");
      yield* fs.makeDirectory(repoRoot, { recursive: true });
      yield* fs.symlink(path.join(source, ".git"), path.join(repoRoot, ".git"));
      const result = yield* placement
        .hydrate({
          repository: "example.com/acme/linkedgit",
          path: "",
          remoteUrl,
          title: "l",
          files: [],
        })
        .pipe(Effect.flip);
      assert.equal(
        result.message,
        "This machine's folder for example.com/acme/linkedgit is not a clone of it.",
      );
    }).pipe(Effect.scoped, Effect.provide(ProcessRunner.layer)),
  ),
);

it.effect("copies only new, ignored env files into a clone, never over its tracked files", () =>
  withPlacement({}, (placement) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // Only the clone's own rules decide what is ignored, not this machine's global ones, which
      // here ignore `.env.local` and could stop doing so later.
      const globalGit = yield* fs.makeTempDirectoryScoped({ prefix: "t3-git-global-" });
      yield* fs.writeFileString(path.join(globalGit, "ignore"), ".env.local\n");
      yield* fs.writeFileString(
        path.join(globalGit, "config"),
        `[core]\n\texcludesFile = ${path.join(globalGit, "ignore")}\n`,
      );
      vi.stubEnv("GIT_CONFIG_GLOBAL", path.join(globalGit, "config"));
      vi.stubEnv("XDG_CONFIG_HOME", yield* fs.makeTempDirectoryScoped({ prefix: "t3-git-xdg-" }));
      yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllEnvs()));
      const { source } = yield* repositoryWithOutsideLink;
      const file = (name: string, text: string) => ({
        path: name,
        contents: Buffer.from(text).toString("base64"),
      });
      yield* placement.hydrate({
        repository: "example.com/acme/tracked",
        path: "",
        remoteUrl: source,
        title: "tracked",
        files: [
          file(".env", "FROM_PEER=1"),
          file(".env.local", "LOCAL=1"),
          // Ignored by this branch's .gitignore, which another branch may not have.
          file(".env.dev", "DEV=1"),
          file(".env.unignored", "WOULD_BE_COMMITTED=1"),
          // As an exclude rule, the line break would unignore the .env.local copied before it.
          file("nested/.env.x\n!/.env.local", "SPLIT=1"),
          file("notes.txt", "not an env file"),
        ],
      });
      const { baseDir } = yield* ServerConfig.ServerConfig;
      const clone = path.join(baseDir, "placement", "repos", "example.com", "acme", "tracked");
      assert.equal(yield* fs.readFileString(path.join(clone, ".env")), "TRACKED=1");
      assert.equal(yield* fs.readFileString(path.join(clone, ".env.local")), "LOCAL=1");
      assert.isFalse(yield* fs.exists(path.join(clone, "notes.txt")));
      assert.isFalse(yield* fs.exists(path.join(clone, ".env.unignored")));
      // What was copied stays out of `git add -A`, which checkpoints use.
      const status = yield* ProcessRunner.ProcessRunner.pipe(
        Effect.flatMap((runner) =>
          runner.run({
            command: "git",
            args: ["-C", clone, "status", "--porcelain", "--ignored=no"],
          }),
        ),
        Effect.provide(ProcessRunner.layer),
        Effect.orDie,
      );
      assert.isFalse(status.timedOut);
      assert.equal(status.code, 0);
      assert.equal(status.stdout.trim(), "");
      // Windows has no owner, group and other bits to check.
      if (HostProcess.Platform.defaultValue() !== "win32") {
        const copied = yield* fs.stat(path.join(clone, ".env.local"));
        assert.equal(copied.mode & 0o777, 0o600);
      }
      const excluded = yield* fs.readFileString(path.join(clone, ".git", "info", "exclude"));
      assert.include(excluded, "/.env.local\n");
      assert.include(excluded, "/.env.dev\n");
      assert.equal(yield* fs.readFileString(path.join(clone, ".env.dev")), "DEV=1");
      // A tracked path missing from a reused clone stays the repository's, never the peer's copy:
      // `.env` is gone from disk, and `.env.Shared` from the index too, tracked only in HEAD.
      yield* fs.remove(path.join(clone, ".env"));
      yield* ProcessRunner.ProcessRunner.pipe(
        Effect.flatMap((runner) =>
          runner.run({
            command: "git",
            args: ["-C", clone, "rm", "-q", "--cached", ".env.Shared"],
          }),
        ),
        Effect.provide(ProcessRunner.layer),
        Effect.orDie,
        Effect.flatMap((result) =>
          result.code === 0 ? Effect.void : Effect.die(`git rm failed: ${result.stderr}`),
        ),
      );
      yield* fs.remove(path.join(clone, ".env.Shared"));
      yield* placement.hydrate({
        repository: "example.com/acme/tracked",
        path: "",
        remoteUrl: source,
        title: "tracked",
        // On a case-insensitive checkout `.env.shared` would land on tracked `.env.Shared`.
        files: [file(".env", "FROM_PEER=1"), file(".env.shared", "FROM_PEER=1")],
      });
      assert.isFalse(yield* fs.exists(path.join(clone, ".env")));
      assert.isFalse(yield* fs.exists(path.join(clone, ".env.shared")));
    }).pipe(Effect.scoped),
  ),
);
