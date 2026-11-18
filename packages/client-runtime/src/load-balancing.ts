import type {
  HostResourcesSnapshot,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";

const GiB = 1024 ** 3;
// srv-2 held 15 agents in about 21 GB of RAM and swap when systemd-oomd started killing them.
const AGENT_MEMORY_BYTES = 1.4 * GiB;
// PSI memory `some` read 65 to 92 on srv-2 while agents were killed, under 2 on idle machines.
// systemd-oomd kills at 60 by default, so stop placing work well before that.
const MEMORY_PRESSURE_LIMIT = 20;

/** How many more agents fit, by memory and by idle cores; 0 when the host is under pressure. */
function freeAgentSlots(resources: HostResourcesSnapshot, cpuUtilization: number): number {
  const { memoryPressure, memoryPressureLevel, agents } = resources;
  const pressure = memoryPressure
    ? Math.max(memoryPressure.someAvg10, memoryPressure.someAvg60)
    : 0;
  if (pressure >= MEMORY_PRESSURE_LIMIT) return 0;
  if (memoryPressureLevel !== undefined && memoryPressureLevel !== "normal") return 0;
  let memoryRoom = resources.availableMemoryBytes;
  let agentMemory = AGENT_MEMORY_BYTES;
  if (agents) {
    if (agents.memoryMaxBytes !== undefined) {
      memoryRoom = Math.min(memoryRoom, agents.memoryMaxBytes - agents.memoryCurrentBytes);
    }
    if (agents.running > 0) {
      agentMemory = Math.max(agentMemory, agents.memoryCurrentBytes / agents.running);
    }
  }
  const memorySlots = Math.floor(memoryRoom / agentMemory);
  if (memorySlots < 1) return 0;
  const cpuSlots = resources.cpuCount * (1 - cpuUtilization);
  return Math.min(memorySlots, cpuSlots) * (1 - pressure / MEMORY_PRESSURE_LIMIT);
}

/** Callers supply only connected machines hosting the project and selected provider. */
export function chooseLoadBalancedEnvironment(
  candidates: ReadonlyArray<{
    environmentId: string;
    resources: HostResourcesSnapshot | null;
    /** Client receipt time avoids comparing clocks on different machines. */
    receivedAt?: number;
    weight: number;
  }>,
  now: number,
): string | null {
  let selected: string | null = null;
  let bestScore = 0;
  for (const { environmentId, resources, receivedAt, weight } of candidates) {
    const sampledAt = receivedAt ?? resources?.sampledAt ?? 0;
    if (
      !resources ||
      !Number.isFinite(weight) ||
      weight <= 0 ||
      now - sampledAt > 15_000 ||
      sampledAt > now + 5_000 ||
      resources.cpuUtilization === null ||
      resources.cpuUtilization >= 0.95 ||
      resources.totalMemoryBytes <= 0 ||
      resources.cpuCount <= 0
    ) {
      continue;
    }
    const score = weight * freeAgentSlots(resources, resources.cpuUtilization);
    if (score > bestScore) {
      selected = environmentId;
      bestScore = score;
    }
  }
  return selected;
}

/** Moves a browser's Auto balance choice for one machine onto that machine, while it has none. */
export function placementMigrationPatch(
  settings: Pick<ServerSettings, "placementWeight">,
  legacy: {
    readonly loadBalancingEnabled: boolean;
    readonly loadBalancingWeights: Readonly<Record<string, number>>;
  },
  environmentId: string,
): ServerSettingsPatch | null {
  if (settings.placementWeight !== null || !legacy.loadBalancingEnabled) return null;
  return { migratePlacementWeight: legacy.loadBalancingWeights[environmentId] ?? 50 };
}
