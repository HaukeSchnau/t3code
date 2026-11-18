import type { HostResourcesSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export function parseMemoryPressure(text: string): HostResourcesSnapshot["memoryPressure"] {
  const match = /^some avg10=(\d+(?:\.\d+)?) avg60=(\d+(?:\.\d+)?) /m.exec(text);
  if (!match) return undefined;
  const someAvg10 = Number(match[1]);
  const someAvg60 = Number(match[2]);
  return someAvg10 <= 100 && someAvg60 <= 100 ? { someAvg10, someAvg60 } : undefined;
}

export function parseSwap(
  meminfo: string,
): Pick<HostResourcesSnapshot, "swapFreeBytes" | "swapTotalBytes"> {
  const total = /^SwapTotal:\s+(\d+) kB$/m.exec(meminfo)?.[1];
  const free = /^SwapFree:\s+(\d+) kB$/m.exec(meminfo)?.[1];
  if (total === undefined || free === undefined) return {};
  const swapTotalBytes = Number(total) * 1024;
  return { swapTotalBytes, swapFreeBytes: Math.min(Number(free) * 1024, swapTotalBytes) };
}

export function parseDarwinMemoryPressureLevel(
  output: string,
): HostResourcesSnapshot["memoryPressureLevel"] {
  switch (output.trim()) {
    case "1":
      return "normal";
    case "2":
      return "warning";
    case "4":
      return "critical";
    default:
      return undefined;
  }
}

// AgentScope names units `t3code-<name>-<8 hex>.scope`; these names are not agent sessions.
const SCOPE_UNIT = /^t3code-(.+)-[0-9a-f]{8}\.scope$/;
const NON_AGENT_SCOPES = new Set(["terminal", "watch", "preview-browser"]);

function isAgentScope(entry: string): boolean {
  const name = SCOPE_UNIT.exec(entry)?.[1];
  return name !== undefined && !NON_AGENT_SCOPES.has(name);
}

/** Reads the agents slice's cgroup directory, whose per-server child slices hold the scopes. */
export const readAgentSlice = Effect.fn("HostPressure.readAgentSlice")(function* (
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const read = (file: string) =>
    fs.readFileString(path.join(directory, file)).pipe(
      Effect.map((text) => text.trim()),
      Effect.orElseSucceed(() => ""),
    );
  const list = (dir: string) => fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));
  const current = yield* read("memory.current");
  if (!/^\d+$/.test(current)) return undefined;
  const max = yield* read("memory.max");
  let running = 0;
  for (const entry of yield* list(directory)) {
    if (isAgentScope(entry)) running++;
    else if (entry.endsWith(".slice")) {
      running += (yield* list(path.join(directory, entry))).filter(isAgentScope).length;
    }
  }
  return {
    running,
    memoryCurrentBytes: Number(current),
    ...(/^\d+$/.test(max) ? { memoryMaxBytes: Number(max) } : {}),
  } satisfies HostResourcesSnapshot["agents"];
});
