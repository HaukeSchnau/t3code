import * as NodeStreamConsumers from "node:stream/consumers";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";

import {
  make,
  makeSystemdScopedCommand,
  nativeProviderSpawn,
  nativeScope,
  shouldUseProviderSystemdScopes,
} from "./ProviderProcessSpawner.ts";

const makeRecordingSpawner = (commands: ChildProcess.Command[]) =>
  ChildProcessSpawner.make((command) => {
    commands.push(command);
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    );
  });

it("enables provider scopes only for opted-in Linux servers", () => {
  assert.isTrue(shouldUseProviderSystemdScopes("linux", { T3_PROVIDER_SYSTEMD_SCOPE: "1" }));
  assert.isFalse(shouldUseProviderSystemdScopes("linux", {}));
  assert.isFalse(shouldUseProviderSystemdScopes("darwin", { T3_PROVIDER_SYSTEMD_SCOPE: "1" }));
});

it("preserves command options when adding the systemd scope boundary", () => {
  const command = makeSystemdScopedCommand(
    ChildProcess.make("codex", ["app-server"], {
      cwd: "/workspace",
      env: { CODEX_HOME: "/codex" },
    }),
    7,
    "42",
  );

  assert.equal(command._tag, "StandardCommand");
  if (command._tag === "StandardCommand") {
    assert.equal(command.command, "systemd-run");
    assert.deepEqual(command.args, [
      "--user",
      "--scope",
      "--quiet",
      "--collect",
      "--slice=t3-providers.slice",
      "--unit=t3-provider-42-7",
      "--property=TimeoutStopSec=15s",
      "--property=MemoryAccounting=yes",
      "--property=IOAccounting=yes",
      "codex",
      "app-server",
    ]);
    assert.equal(command.options.cwd, "/workspace");
    assert.deepEqual(command.options.env, { CODEX_HOME: "/codex" });
  }
});

it.effect("assigns a distinct scope to each provider process", () =>
  Effect.gen(function* () {
    const commands: ChildProcess.Command[] = [];
    const underlying = makeRecordingSpawner(commands);
    const scoped = make(underlying, {
      platform: "linux",
      environment: { T3_PROVIDER_SYSTEMD_SCOPE: "1" },
      ownerId: "test",
    });

    yield* Effect.scoped(scoped.spawn(ChildProcess.make("codex", ["app-server"])));
    yield* Effect.scoped(scoped.spawn(ChildProcess.make("claude", ["--print"])));

    assert.equal(commands[0]?._tag, "StandardCommand");
    assert.equal(commands[1]?._tag, "StandardCommand");
    if (commands[0]?._tag === "StandardCommand" && commands[1]?._tag === "StandardCommand") {
      assert.include(commands[0].args, "--unit=t3-provider-test-1");
      assert.include(commands[1].args, "--unit=t3-provider-test-2");
    }
  }),
);

it.effect("passes commands through unchanged when scopes are disabled", () =>
  Effect.gen(function* () {
    const commands: ChildProcess.Command[] = [];
    const underlying = makeRecordingSpawner(commands);
    const command = ChildProcess.make("codex", ["app-server"], { cwd: "/workspace" });

    const linuxOptOut = make(underlying, {
      platform: "linux",
      environment: {},
      ownerId: "test",
    });
    const nonLinux = make(underlying, {
      platform: "darwin",
      environment: { T3_PROVIDER_SYSTEMD_SCOPE: "1" },
      ownerId: "test",
    });

    yield* Effect.scoped(linuxOptOut.spawn(command));
    yield* Effect.scoped(nonLinux.spawn(command));

    assert.strictEqual(commands[0], command);
    assert.strictEqual(commands[1], command);
  }),
);

// The stand-in systemd-run is a shell script.
it.effect.skipIf(HostProcessPlatform.defaultValue() === "win32")(
  "starts a native launch through the project launcher inside its own scope",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const hostCwd = yield* fileSystem.realPath(
          yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-native-scope-" }),
        );
        const systemdRun = path.join(hostCwd, "systemd-run");
        yield* fileSystem.writeFileString(systemdRun, '#!/bin/sh\npwd\nprintf "%s\\n" "$@"\n');
        yield* fileSystem.chmod(systemdRun, 0o755);
        const scope = yield* nativeScope.pipe(
          Effect.provideService(HostProcessPlatform, "linux"),
          Effect.provideService(HostProcessEnvironment, { T3_PROVIDER_SYSTEMD_SCOPE: "1" }),
        );
        const spawn = nativeProviderSpawn({
          scope,
          project: {
            cwd: "/workspace",
            endpoint: (endpoint) => endpoint,
            hostCwd,
            launcher: "/run/agent-exec",
          },
        });
        assert.isDefined(spawn);

        const child = spawn({
          command: "claude",
          args: ["--verbose"],
          cwd: "/workspace",
          env: { PATH: hostCwd },
          signal: new AbortController().signal,
        });
        const [cwd, ...argv] = (yield* Effect.promise(() => NodeStreamConsumers.text(child.stdout)))
          .trimEnd()
          .split("\n");

        assert.equal(cwd, hostCwd);
        assert.include(argv, "--slice=t3-providers.slice");
        assert.deepEqual(argv.slice(argv.indexOf("/run/agent-exec")), [
          "/run/agent-exec",
          "auto",
          "--cwd",
          hostCwd,
          "--",
          "claude",
          "--verbose",
        ]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
