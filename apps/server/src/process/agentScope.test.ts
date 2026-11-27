// @effect-diagnostics nodeBuiltinImport:off -- fake systemd binaries live in a temp dir.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import { makeCodexAppServerSpawnCommand } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProviderProcesses from "./providerProcesses.ts";
import {
  agentMemoryLimits,
  classifyScope,
  make,
  ownedAgentSlice,
  type ScopeState,
} from "./agentScope.ts";

const GiB = 1024 ** 3;
const memory = vi.hoisted(() => ({ total: 16 * 1024 ** 3, swapKb: 2 * 1024 ** 2 }));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  totalmem: () => memory.total,
}));

const running: ScopeState = {
  loadState: "loaded",
  activeState: "active",
  result: "success",
  oomKills: 0,
  populated: true,
};

describe("classifyScope", () => {
  it("reports an OOM kill only once systemd records it", () => {
    expect(classifyScope({ ...running, activeState: "failed", result: "oom-kill" })).toBe(
      "oom-killed",
    );
    expect(classifyScope({ ...running, oomKills: 1 })).toBe("stopping");
    expect(classifyScope({ ...running, populated: false })).toBe("stopping");
    expect(classifyScope({ ...running, activeState: "deactivating" })).toBe("stopping");
  });

  it("reports a continuing scope's OOM kills that were not reported yet", () => {
    expect(classifyScope({ ...running, oomKills: 1 }, 0)).toBe("oom-killed");
    expect(classifyScope({ ...running, oomKills: 1 }, 1)).toBe("running");
    expect(classifyScope({ ...running, activeState: "inactive", oomKills: 2 }, 1)).toBe(
      "oom-killed",
    );
    expect(classifyScope({ ...running, populated: false }, 0)).toBe("running");
  });
});

describe("agentMemoryLimits", () => {
  it("gives each session a quarter of RAM, at least 4 GiB and at most the slice", () => {
    expect(agentMemoryLimits(64 * GiB, true, {}).session).toBe(16 * GiB);
    expect(agentMemoryLimits(8 * GiB, true, {}).session).toBe(4 * GiB);
    expect(agentMemoryLimits(4 * GiB, true, {}).session).toBe(3 * GiB);
  });

  it("takes a host's budget from the environment", () => {
    expect(
      agentMemoryLimits(24 * GiB, true, {
        T3CODE_AGENT_MEMORY_HIGH: "9G",
        T3CODE_AGENT_MEMORY_MAX: "10G",
        T3CODE_AGENT_SESSION_MEMORY_MAX: "6G",
      }),
    ).toEqual({ high: "9G", max: "10G", session: "6G" });
  });
});

interface FakeUnit {
  activeState: string;
  result: string;
  controlGroup?: string;
}

const withFakeSystemd = <A, E>(
  body: (input: {
    readonly scope: Effect.Success<typeof make>;
    readonly units: Map<string, FakeUnit>;
    readonly calls: ReadonlyArray<ReadonlyArray<string>>;
    readonly failingVerbs: Set<string>;
    readonly stateDir: string;
    readonly cgroupRoot: string;
  }) => Effect.Effect<A, E>,
  // A user manager older than systemd 253 rejects OOMPolicy on scopes, and
  // systemd-run older than 254 rejects --expand-environment.
  {
    oomPolicy = true,
    expandEnvironment = true,
    stopFails = false,
    leftovers = false,
    liveOwner = false,
  }: {
    readonly oomPolicy?: boolean;
    readonly expandEnvironment?: boolean;
    readonly stopFails?: boolean;
    readonly leftovers?: boolean;
    readonly liveOwner?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const bin = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-agent-scope-"));
    for (const name of ["systemd-run", "systemctl", "getfattr", "agent"]) {
      NodeFS.writeFileSync(NodePath.join(bin, name), "", { mode: 0o755 });
    }
    const cgroupRoot = NodePath.join(bin, "cgroup");
    const units = new Map<string, FakeUnit>();
    const calls: Array<ReadonlyArray<string>> = [];
    const failingVerbs = new Set<string>();
    const output = (stdout: string, code = 0): ProcessRunner.ProcessRunOutput => ({
      stdout,
      stderr: "",
      code: ChildProcessSpawner.ExitCode(code),
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutInvalidUtf8: false,
      stderrInvalidUtf8: false,
    });
    const runner = ProcessRunner.ProcessRunner.of({
      run: ({ command, args }) =>
        Effect.sync(() => {
          calls.push(args);
          if (command.endsWith("/getfattr")) {
            const xattr = NodePath.join(
              String(args.at(-1)).replace("/sys/fs/cgroup", cgroupRoot),
              String(args.at(-2)),
            );
            return NodeFS.existsSync(xattr)
              ? output(NodeFS.readFileSync(xattr, "utf8"))
              : output("", 1);
          }
          if (!oomPolicy && args.some((arg) => arg.startsWith("--property=OOMPolicy="))) {
            return output("", 1);
          }
          if (!expandEnvironment && args.some((arg) => arg.startsWith("--expand-environment"))) {
            return output("", 1);
          }
          const [, verb, unit = ""] = args;
          if (failingVerbs.has(verb!)) return output("", 1);
          if (stopFails && verb === "stop") {
            return {
              ...output(""),
              stderr: `Failed to stop ${args.at(-1)}: Unit not loaded.`,
              code: ChildProcessSpawner.ExitCode(5),
            };
          }
          if (verb === "reset-failed") units.delete(unit);
          if (verb !== "show") return output("");
          const state = units.get(unit);
          return output(
            state === undefined
              ? "LoadState=not-found\nActiveState=inactive\nResult=success\n"
              : `LoadState=loaded\nActiveState=${state.activeState}\nResult=${state.result}\n` +
                  `ControlGroup=${state.controlGroup ?? ""}\n`,
          );
        }),
    });
    const fileSystem = yield* FileSystem.FileSystem;
    const { stateDir } = yield* ServerConfig.ServerConfig;
    if (leftovers) {
      units.set(ownedAgentSlice(stateDir), { activeState: "active", result: "success" });
    }
    const scope = yield* make.pipe(
      Effect.provideService(ProviderProcesses.ProviderProcesses, { hasOtherLiveOwner: liveOwner }),
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Environment, { PATH: bin, XDG_RUNTIME_DIR: "/run/user/1" }),
      Effect.provideService(FileSystem.FileSystem, {
        ...fileSystem,
        readFileString: (path, encoding) =>
          path === "/proc/meminfo"
            ? Effect.sync(() => `MemTotal:       16384 kB\nSwapTotal:      ${memory.swapKb} kB\n`)
            : fileSystem.readFileString(path.replace("/sys/fs/cgroup", cgroupRoot), encoding),
        writeFileString: (path, data, options) =>
          fileSystem.writeFileString(path.replace("/sys/fs/cgroup", cgroupRoot), data, options),
      }),
    );
    return yield* body({ scope, units, calls, failingVerbs, stateDir, cgroupRoot }).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(bin, { recursive: true, force: true }))),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-agent-scope-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

const unitOf = (launch: Pick<ChildProcess.StandardCommand, "args">) =>
  launch.args
    .map(String)
    .find((arg) => arg.startsWith("--unit="))
    ?.slice("--unit=".length) ?? "";

const sliceOf = (launch: { readonly args: ReadonlyArray<string> }) =>
  launch.args.find((arg) => arg.startsWith("--slice="))?.slice("--slice=".length) ?? "";

/** An active scope as systemd and the kernel report it, with the agent itself gone. */
const exitedAgent = (
  units: Map<string, FakeUnit>,
  cgroupRoot: string,
  unit: string,
  {
    populated,
    oomKills,
    oomdKills,
  }: {
    readonly populated: boolean;
    readonly oomKills: number | undefined;
    readonly oomdKills?: number;
  },
) => {
  const controlGroup = `/${unit}`;
  NodeFS.mkdirSync(NodePath.join(cgroupRoot, controlGroup), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(cgroupRoot, controlGroup, "cgroup.events"),
    `populated ${populated ? 1 : 0}\nfrozen 0\n`,
  );
  // An undefined count leaves memory.events unreadable.
  if (oomKills !== undefined) {
    NodeFS.writeFileSync(
      NodePath.join(cgroupRoot, controlGroup, "memory.events"),
      `low 0\nhigh 0\nmax 0\noom ${oomKills}\noom_kill ${oomKills}\noom_group_kill 0\n`,
    );
  }
  // The fake getfattr reads an xattr from a file of the same name.
  if (oomdKills !== undefined) {
    NodeFS.writeFileSync(NodePath.join(cgroupRoot, controlGroup, "user.oomd_ooms"), `${oomdKills}`);
  }
  units.set(unit, { activeState: "active", result: "success", controlGroup });
};

const stopsOf = (calls: ReadonlyArray<ReadonlyArray<string>>) =>
  calls.filter(([, verb]) => verb === "stop");
const launchCodex = (
  scope: Effect.Success<typeof make>,
  threadId: string,
  env?: NodeJS.ProcessEnv,
) =>
  makeCodexAppServerSpawnCommand({ command: "agent", args: ["app-server"], threadId, env }).pipe(
    Effect.provideService(AgentScope, scope),
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.map((command) => {
      assert(ChildProcess.isStandardCommand(command));
      return command;
    }),
  );

describe("AgentScope service", () => {
  it.effect("labels a thread from its newest scope until its next session clears it", () =>
    withFakeSystemd(({ scope, units }) =>
      Effect.gen(function* () {
        const first = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        units.set(unitOf(first), { activeState: "failed", result: "oom-kill" });
        const second = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        units.set(unitOf(second), { activeState: "active", result: "success" });
        expect(yield* scope.oomKilled("a")).toBe(false);

        units.set(unitOf(second), { activeState: "failed", result: "oom-kill" });
        expect(yield* scope.oomKilled("a")).toBe(true);
        units.delete(unitOf(second));
        expect(yield* scope.oomKilled("a")).toBe(true);

        yield* scope.clear("a");
        expect(yield* scope.oomKilled("a")).toBe(false);
      }),
    ),
  );

  it.effect(
    "keeps shared Codex scopes running without attributing their OOM to the launch thread",
    () =>
      withFakeSystemd(({ scope, units, calls }) =>
        Effect.gen(function* () {
          const agent = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
          units.set(unitOf(agent), { activeState: "failed", result: "oom-kill" });
          expect(yield* scope.oomKilled("a")).toBe(true);

          const executable = String(agent.args.at(-1));
          const codex = yield* launchCodex(scope, "a", {
            PATH: NodePath.relative(process.cwd(), NodePath.dirname(executable)),
          });
          // Anchored to the cwd for systemd-run, with its ".." kept; it names the same file.
          const anchored = String(codex.args.at(-2));
          expect(NodePath.isAbsolute(anchored)).toBe(true);
          expect(NodePath.resolve(anchored)).toBe(executable);
          expect(codex.args).toContain("--property=OOMPolicy=continue");
          expect(codex.args).toContain("--property=TimeoutStopSec=10s");
          expect(codex.args).toContain("--collect");
          units.set(unitOf(codex), { activeState: "active", result: "success" });
          expect(yield* scope.oomKilled("a")).toBe(false);
          units.set(unitOf(codex), { activeState: "failed", result: "oom-kill" });
          expect(yield* scope.oomKilled("a")).toBe(false);
          expect(
            calls.filter(([, verb, unit]) => verb === "show" && unit === unitOf(codex)),
          ).toEqual([]);
        }),
      ),
  );

  it.effect.skipIf(!symlinksSupported)(
    "keeps a symlinked parent in absolute and relative executable paths",
    () =>
      withFakeSystemd(({ scope }) =>
        Effect.gen(function* () {
          const plain = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "s" });
          const bin = NodePath.dirname(String(plain.args.at(-1)));
          NodeFS.mkdirSync(NodePath.join(bin, "real", "sub"), { recursive: true });
          NodeFS.writeFileSync(NodePath.join(bin, "real", "agent"), "", { mode: 0o755 });
          NodeFS.symlinkSync(NodePath.join(bin, "real", "sub"), NodePath.join(bin, "link"));
          // The kernel follows the link before "..", so this names real/agent, not bin/agent.
          const command = `${NodePath.join(bin, "link")}/../agent`;
          const wrapped = yield* scope.wrap({ command, args: [], name: "t", threadId: "s" });
          expect(wrapped.args.at(-1)).toBe(command);
          // A relative path is anchored to the cwd the same way, without collapsing "..".
          const relative = `${NodePath.relative(process.cwd(), NodePath.join(bin, "link"))}/../agent`;
          const anchored = yield* scope.wrap({
            command: relative,
            args: [],
            name: "t",
            threadId: "s",
          });
          expect(anchored.args.at(-1)).toBe(`${process.cwd()}${NodePath.sep}${relative}`);
        }),
      ),
  );

  it.effect.each([{ oomPolicy: true }, { oomPolicy: false }])(
    "Force stop kills a thread's own scope but never a shared Codex scope (OOM policy $oomPolicy)",
    ({ oomPolicy }) =>
      withFakeSystemd(
        ({ scope, units, calls, cgroupRoot }) =>
          Effect.gen(function* () {
            const agent = yield* scope.wrap({
              command: "agent",
              args: [],
              name: "t",
              threadId: "a",
            });
            exitedAgent(units, cgroupRoot, unitOf(agent), { populated: true, oomKills: 0 });
            const codex = yield* launchCodex(scope, "b");
            exitedAgent(units, cgroupRoot, unitOf(codex), { populated: true, oomKills: 0 });

            expect(yield* scope.kill("a")).toBe(true);
            expect(
              NodeFS.readFileSync(NodePath.join(cgroupRoot, unitOf(agent), "cgroup.kill"), "utf8"),
            ).toBe("1");
            expect(yield* scope.kill("b")).toBe(false);
            expect(NodeFS.existsSync(NodePath.join(cgroupRoot, unitOf(codex), "cgroup.kill"))).toBe(
              false,
            );
            expect(calls.filter(([, verb]) => verb === "kill")).toEqual([]);
          }),
        { oomPolicy },
      ),
  );

  it.effect("keeps a running scope while hundreds of other threads launch", () =>
    withFakeSystemd(({ scope, units }) =>
      Effect.gen(function* () {
        const live = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "live" });
        units.set(unitOf(live), { activeState: "active", result: "success" });
        for (let index = 0; index < 600; index++) {
          yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: `other-${index}` });
        }
        units.set(unitOf(live), { activeState: "failed", result: "oom-kill" });
        expect(yield* scope.oomKilled("live")).toBe(true);
      }),
    ),
  );

  it.effect.each([{ expandEnvironment: true }, { expandEnvironment: false }])(
    "delegates every agent scope, and keeps systemd from expanding ${VAR} where it can (supported $expandEnvironment)",
    ({ expandEnvironment }) =>
      withFakeSystemd(
        ({ scope }) =>
          Effect.gen(function* () {
            const agent = yield* scope.wrap({
              command: "agent",
              args: [],
              name: "t",
              threadId: "a",
            });
            const codex = yield* launchCodex(scope, "a");
            const terminal = yield* scope.wrap({
              command: "agent",
              args: [],
              name: "terminal",
              survivesRestart: true,
            });
            for (const launch of [agent, codex, terminal]) {
              expect(launch.args).toContain("--property=Delegate=yes");
              const systemdRunArgs = launch.args.slice(0, launch.args.indexOf("--"));
              expect(systemdRunArgs.includes("--expand-environment=no")).toBe(expandEnvironment);
            }
          }),
        { expandEnvironment },
      ),
  );

  it.effect("caps agent memory and yields CPU, disk, and tasks to the server", () =>
    withFakeSystemd(({ scope, calls }) =>
      Effect.gen(function* () {
        yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        const setProperties = calls.filter(([, verb]) => verb === "set-property");
        expect(setProperties).toEqual([
          [
            "--user",
            "set-property",
            "--runtime",
            "app-t3code-agents.slice",
            expect.stringMatching(/^MemoryHigh=\d+$/),
            expect.stringMatching(/^MemoryMax=\d+$/),
          ],
          [
            "--user",
            "set-property",
            "--runtime",
            "app-t3code.slice",
            "CPUWeight=10",
            "IOWeight=10",
            "TasksMax=25%",
          ],
        ]);
      }),
    ),
  );

  it.effect("follows a live memory or swap change at the next launch", () => {
    memory.total = 16 * GiB;
    memory.swapKb = 2 * 1024 ** 2;
    return withFakeSystemd(({ scope, calls, failingVerbs }) =>
      Effect.gen(function* () {
        const launch = scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        const memoryLimits = () =>
          calls
            .filter(
              ([, verb, , slice]) => verb === "set-property" && slice === "app-t3code-agents.slice",
            )
            .map((args) => args.slice(4));
        yield* launch;
        yield* launch;
        expect(memoryLimits()).toEqual([[`MemoryHigh=${10 * GiB}`, `MemoryMax=${12 * GiB}`]]);

        // A VM balloon or `pct set --memory` grows RAM while the server keeps running.
        memory.total = 22 * GiB;
        failingVerbs.add("set-property");
        yield* launch;
        yield* launch;
        failingVerbs.delete("set-property");
        yield* launch;
        yield* launch;
        const grown = [`MemoryHigh=${16 * GiB}`, `MemoryMax=${18 * GiB}`];
        expect(memoryLimits()).toEqual([
          [`MemoryHigh=${10 * GiB}`, `MemoryMax=${12 * GiB}`],
          grown,
          grown,
          grown,
        ]);

        // Without swap, MemoryHigh only throttles; MemoryMax must OOM-kill the runaway.
        memory.swapKb = 0;
        yield* launch;
        expect(memoryLimits().at(-1)).toEqual(["MemoryHigh=infinity", `MemoryMax=${18 * GiB}`]);
        memory.swapKb = 2 * 1024 ** 2;
      }),
    );
  });

  it.effect("stops agents a killed server left before startup completes", () =>
    withFakeSystemd(
      ({ scope, calls, stateDir }) =>
        Effect.gen(function* () {
          expect(stopsOf(calls)).toEqual([["--user", "stop", ownedAgentSlice(stateDir)]]);
          const agent = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
          expect(sliceOf(agent)).toBe(ownedAgentSlice(stateDir));
          expect(agent.args).toContain("--property=TimeoutStopSec=10s");
          const terminal = yield* scope.wrap({
            command: "agent",
            args: [],
            name: "terminal",
            survivesRestart: true,
          });
          expect(sliceOf(terminal)).toBe("app-t3code-agents.slice");
          expect(stopsOf(calls)).toHaveLength(1);
        }),
      { leftovers: true },
    ),
  );

  it.effect("leaves the slice to another live server sharing this home", () =>
    withFakeSystemd(({ calls }) => Effect.sync(() => expect(stopsOf(calls)).toEqual([])), {
      leftovers: true,
      liveOwner: true,
    }),
  );

  it.effect("stops leftover processes only in an active agent scope", () =>
    withFakeSystemd(({ scope, units, calls, cgroupRoot }) =>
      Effect.gen(function* () {
        const agent = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        const unit = unitOf(agent);
        expect(agent.unit).toBe(unit);

        yield* scope.stop("session-2.scope");
        expect(calls.some((args) => args.includes("session-2.scope"))).toBe(false);
        yield* scope.stop(unit);
        exitedAgent(units, cgroupRoot, unit, { populated: false, oomKills: 0 });
        yield* scope.stop(unit);
        exitedAgent(units, cgroupRoot, unit, { populated: true, oomKills: 0 });
        units.get(unit)!.activeState = "deactivating";
        yield* scope.stop(unit);
        expect(stopsOf(calls)).toEqual([]);

        units.get(unit)!.activeState = "active";
        yield* scope.stop(unit);
        expect(stopsOf(calls)).toEqual([["--user", "stop", "--no-block", unit]]);
        expect(yield* scope.oomKilled("a")).toBe(false);
      }),
    ),
  );

  it.effect.each([true, false])(
    "cleans up an OOM exit without losing its diagnosis (OOMPolicy=%s)",
    (oomPolicy) =>
      withFakeSystemd(
        ({ scope, units, calls, cgroupRoot }) =>
          Effect.gen(function* () {
            const agent = yield* scope.wrap({
              command: "agent",
              args: [],
              name: "t",
              threadId: "a",
            });
            const unit = unitOf(agent);
            // The kernel records the kill before the agent's exit reaches us.
            exitedAgent(units, cgroupRoot, unit, { populated: true, oomKills: 1 });
            yield* scope.stop(unit);
            expect(stopsOf(calls)).toEqual([["--user", "stop", "--no-block", unit]]);

            if (oomPolicy) {
              // Under OOMPolicy=continue systemd records no result, and the stop removes the scope.
              units.delete(unit);
              expect(yield* scope.oomKilled("a")).toBe(true);
              expect(yield* scope.oomKilled("a")).toBe(false);
            } else {
              units.set(unit, { activeState: "failed", result: "oom-kill" });
              expect(yield* scope.oomKilled("a")).toBe(true);
            }
          }),
        { oomPolicy },
      ),
  );

  it.effect("caps each session, but not a scope that several sessions share", () =>
    withFakeSystemd(({ scope }) =>
      Effect.gen(function* () {
        const server = yield* scope.wrap({ command: "agent", args: [], name: "s", shared: true });
        const agent = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        const terminal = yield* scope.wrap({
          command: "agent",
          args: [],
          name: "terminal",
          survivesRestart: true,
        });
        for (const launch of [server, agent, terminal]) {
          expect(launch.args).toContain("--property=OOMPolicy=continue");
        }
        const caps = (launch: { readonly args: ReadonlyArray<string> }) =>
          launch.args.filter((arg) => arg.startsWith("--property=MemoryMax="));
        expect(caps(server)).toEqual([]);
        expect(caps(agent)).toHaveLength(1);
        expect(caps(terminal)).toEqual(caps(agent));
      }),
    ),
  );

  it.effect("reports each OOM kill in a session that outlives it once", () =>
    withFakeSystemd(({ scope, units, cgroupRoot }) =>
      Effect.gen(function* () {
        const agent = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        const unit = unitOf(agent);
        exitedAgent(units, cgroupRoot, unit, { populated: true, oomKills: 0 });
        expect(yield* scope.oomKilled("a")).toBe(false);

        exitedAgent(units, cgroupRoot, unit, { populated: true, oomKills: 1 });
        expect(yield* scope.oomKilled("a")).toBe(true);
        expect(yield* scope.oomKilled("a")).toBe(false);

        exitedAgent(units, cgroupRoot, unit, { populated: false, oomKills: 2 });
        units.get(unit)!.activeState = "inactive";
        expect(yield* scope.oomKilled("a")).toBe(true);
      }),
    ),
  );

  it.effect("reports a scope systemd-oomd killed, though the kernel counted no OOM kill", () =>
    withFakeSystemd(({ scope, units, calls, cgroupRoot }) =>
      Effect.gen(function* () {
        // oomd marks the cgroup before it kills it; systemd notices only once the cgroup empties.
        const first = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        exitedAgent(units, cgroupRoot, unitOf(first), {
          populated: true,
          oomKills: 0,
          oomdKills: 1,
        });
        expect(yield* scope.oomKilled("a")).toBe(true);

        const second = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "b" });
        const unit = unitOf(second);
        exitedAgent(units, cgroupRoot, unit, { populated: true, oomKills: 0, oomdKills: 1 });
        yield* scope.stop(unit);
        expect(stopsOf(calls)).toEqual([]);
        units.delete(unit);
        NodeFS.rmSync(NodePath.join(cgroupRoot, unit), { recursive: true });
        expect(yield* scope.oomKilled("b")).toBe(true);
      }),
    ),
  );

  it.effect("reports failed daemon cleanup without failing session teardown", () => {
    const warnings: Array<unknown> = [];
    const logger = Logger.make(({ message }) => {
      warnings.push(message);
    });
    return withFakeSystemd(
      ({ scope, units, cgroupRoot }) =>
        Effect.gen(function* () {
          const agent = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
          exitedAgent(units, cgroupRoot, unitOf(agent), { populated: true, oomKills: 0 });
          yield* scope.stop(unitOf(agent));
          expect(warnings.flat()).toContain("Could not stop an exited agent's scope");
        }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false }))),
      { stopFails: true },
    );
  });

  it.effect("leaves a quiet slice alone", () =>
    withFakeSystemd(({ scope, calls }) =>
      Effect.gen(function* () {
        yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        expect(calls.filter(([, verb]) => verb === "stop")).toEqual([]);
      }),
    ),
  );
});
