import * as NodeOS from "node:os";
import type { HostResourcesSnapshot } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { AGENT_SLICE } from "../process/agentScope.ts";
import {
  parseDarwinMemoryPressureLevel,
  parseMemoryPressure,
  parseSwap,
  readAgentSlice,
} from "./HostPressure.ts";

export class HostResources extends Context.Service<
  HostResources,
  { readonly read: Effect.Effect<HostResourcesSnapshot> }
>()("t3/resourceTelemetry/HostResources") {}

function readCpu() {
  const cpus = NodeOS.cpus();
  const cpu = cpus.reduce(
    (sum, { times }) => ({
      idle: sum.idle + times.idle,
      total: sum.total + times.user + times.nice + times.sys + times.idle + times.irq,
    }),
    { idle: 0, total: 0 },
  );
  return { ...cpu, count: cpus.length };
}

function darwinAvailableMemory(output: string): number | null {
  const pageSize = /page size of (\d+) bytes/.exec(output)?.[1];
  const free = /^Pages free:\s+(\d+)\./m.exec(output)?.[1];
  const inactive = /^Pages inactive:\s+(\d+)\./m.exec(output)?.[1];
  const speculative = /^Pages speculative:\s+(\d+)\./m.exec(output)?.[1];
  if (!pageSize || !free || !inactive || !speculative) return null;
  // vm_stat excludes speculative from free; add it once, without overlapping purgeable pages.
  const available = (Number(free) + Number(inactive) + Number(speculative)) * Number(pageSize);
  return Number.isSafeInteger(available) && Number(pageSize) > 0 ? available : null;
}

const make = Effect.fn("makeHostResources")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const runString = (command: string, args: ReadonlyArray<string>) =>
    spawner.string(ChildProcess.make(command, args, { stdin: "ignore", stderr: "ignore" })).pipe(
      Effect.timeout("1 second"),
      Effect.orElseSucceed(() => ""),
    );
  // The slice appears with the first agent; until then each sample asks systemd again.
  let agentSliceDirectory: string | undefined;
  const resolveAgentSlice = Effect.gen(function* () {
    if (agentSliceDirectory !== undefined) return agentSliceDirectory;
    const controlGroup = (yield* runString("systemctl", [
      "--user",
      "show",
      AGENT_SLICE,
      "--property=ControlGroup",
      "--value",
    ])).trim();
    if (controlGroup.startsWith("/")) agentSliceDirectory = `/sys/fs/cgroup${controlGroup}`;
    return agentSliceDirectory;
  });

  const sample = Effect.fn("HostResources.sample")(function* () {
    const previousCpu = readCpu();
    yield* Effect.sleep("200 millis");
    const cpu = readCpu();
    const totalDelta = cpu.total - previousCpu.total;
    const idleDelta = cpu.idle - previousCpu.idle;
    const cpuUtilization =
      previousCpu.count === cpu.count && totalDelta > 0 && idleDelta >= 0
        ? Math.min(1, Math.max(0, 1 - idleDelta / totalDelta))
        : null;
    const totalMemoryBytes = NodeOS.totalmem();
    // On Windows libuv returns GlobalMemoryStatusEx.ullAvailPhys, including standby memory.
    let availableMemoryBytes = NodeOS.freemem();
    let pressure: Partial<HostResourcesSnapshot> = {};
    if (platform === "linux") {
      const meminfo = yield* fs
        .readFileString("/proc/meminfo")
        .pipe(Effect.orElseSucceed(() => ""));
      const available = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo)?.[1];
      if (available) availableMemoryBytes = Number(available) * 1024;
      const memoryPressure = parseMemoryPressure(
        yield* fs.readFileString("/proc/pressure/memory").pipe(Effect.orElseSucceed(() => "")),
      );
      const sliceDirectory = yield* resolveAgentSlice;
      const agents =
        sliceDirectory === undefined ? undefined : yield* readAgentSlice(sliceDirectory);
      pressure = {
        ...(memoryPressure ? { memoryPressure } : {}),
        ...parseSwap(meminfo),
        ...(agents ? { agents } : {}),
      };
    } else if (platform === "darwin") {
      const output = yield* runString("/usr/bin/vm_stat", []);
      availableMemoryBytes = darwinAvailableMemory(output) ?? availableMemoryBytes;
      const memoryPressureLevel = parseDarwinMemoryPressureLevel(
        yield* runString("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]),
      );
      if (memoryPressureLevel) pressure = { memoryPressureLevel };
    }
    return {
      sampledAt: DateTime.toEpochMillis(yield* DateTime.now),
      cpuUtilization,
      cpuCount: cpu.count,
      availableMemoryBytes: Math.min(totalMemoryBytes, Math.max(0, availableMemoryBytes)),
      totalMemoryBytes,
      ...pressure,
    };
  });

  const cache = yield* Cache.make({
    capacity: 1,
    lookup: (_key: "host") => sample(),
    timeToLive: "5 seconds",
  });
  return HostResources.of({ read: Cache.get(cache, "host") });
});

export const layer = Layer.effect(HostResources, make());
