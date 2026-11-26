// Fork (patches/fleet-placement.md): how placement scores machines for a new thread.
import type {
  EnvironmentId,
  HostResourcesSnapshot,
  PlacementCandidate,
  PlacementReport,
} from "@t3tools/contracts";

const GiB = 1024 ** 3;
// srv-2 held 15 agents in about 21 GB of RAM and swap when systemd-oomd started killing them.
const AGENT_MEMORY_BYTES = 1.4 * GiB;
// PSI memory `some` read 65 to 92 on srv-2 while agents were killed, under 2 on idle machines.
// systemd-oomd kills at 60 by default, so stop placing work well before that.
const MEMORY_PRESSURE_LIMIT = 20;
/** A report older than this, by the reader's clock, no longer describes the machine. */
const PLACEMENT_REPORT_FRESH_MS = 15_000;

export interface AgentLoad {
  readonly resources: HostResourcesSnapshot;
  /** Agents the host runs now, when it counts them itself. */
  readonly runningAgents?: number;
  /** Launches that will start an agent there soon. */
  readonly launchesInFlight?: number;
  readonly agentLimit?: number | null;
  /** A T3 release waits for the host to go idle; it has no room until the release lands. */
  readonly updating?: boolean | undefined;
}

/**
 * How many more agents fit, by memory, idle cores and the host's own limit, with why none does.
 * Launches in flight have not used memory or CPU yet, so they count against every bound. A host
 * with a free slot is admissible; `preference` also scales its slots down as memory pressure rises,
 * so a calmer host wins a tie.
 */
export function freeAgentSlots(load: AgentLoad): {
  slots: number;
  preference: number;
  note: string | null;
} {
  const { resources } = load;
  const { memoryPressure, memoryPressureLevel, agents } = resources;
  const inFlight = load.launchesInFlight ?? 0;
  const none = (note: string) => ({ slots: 0, preference: 0, note });
  if (load.updating === true) return none("is updating");
  const pressure = memoryPressure
    ? Math.max(memoryPressure.someAvg10, memoryPressure.someAvg60)
    : 0;
  if (pressure >= MEMORY_PRESSURE_LIMIT) {
    return none(`at ${Math.round(pressure)}% memory pressure`);
  }
  if (memoryPressureLevel !== undefined && memoryPressureLevel !== "normal") {
    return none(`at ${memoryPressureLevel} memory pressure`);
  }
  // The load average follows sustained work such as a nightly backup; one sample only a moment.
  const cpuBusy =
    resources.loadAverage !== undefined && resources.cpuCount > 0
      ? Math.min(1, resources.loadAverage / resources.cpuCount)
      : resources.cpuUtilization;
  if (cpuBusy === null || resources.cpuCount <= 0) return none("reports no CPU load");
  if (cpuBusy >= 0.95) return none(`at ${Math.round(cpuBusy * 100)}% CPU`);
  const running = load.runningAgents ?? agents?.running ?? 0;
  if (load.agentLimit != null && running + inFlight >= load.agentLimit) {
    return none(`at its limit of ${load.agentLimit} agents`);
  }
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
  const memorySlots = Math.floor(memoryRoom / agentMemory) - inFlight;
  if (memorySlots < 1) return none(`has ${(Math.max(0, memoryRoom) / GiB).toFixed(1)} GiB free`);
  const cpuSlots = resources.cpuCount * (1 - cpuBusy) - inFlight;
  if (cpuSlots < 1) return none("has no idle cores");
  const limitSlots =
    load.agentLimit == null ? Number.POSITIVE_INFINITY : load.agentLimit - running - inFlight;
  const slots = Math.min(memorySlots, cpuSlots, limitSlots);
  return { slots, preference: slots * (1 - pressure / MEMORY_PRESSURE_LIMIT), note: null };
}

export interface PlacementOption {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** The machine's last report, with when this reader received it. */
  readonly report: PlacementReport | null;
  readonly receivedAt: number;
  /** Launches the reader sent there that the report may not show yet. */
  readonly sentLaunches: number;
  /** 1 warm, below 1 cold, or why the machine cannot take this thread at all. */
  readonly warmth: number | { readonly unavailable: string };
}

export interface PlacementDecision {
  readonly chosen: PlacementCandidate;
  /** No machine has room; the thread waits on `chosen`. */
  readonly wait: boolean;
  readonly reason: string;
  readonly candidates: ReadonlyArray<PlacementCandidate>;
}

/**
 * Picks the machine with the highest weight × free agent slots × warmth. A machine past its
 * pressure limit has no slots. When none has room, the thread waits on the machine it would
 * prefer by weight and warmth, behind the fewest others.
 */
export function decidePlacement(
  options: ReadonlyArray<PlacementOption>,
  now: number,
): PlacementDecision | null {
  const scored = options.map((option) => {
    const base = { environmentId: option.environmentId, label: option.label };
    const { report } = option;
    if (typeof option.warmth !== "number") {
      return {
        ...base,
        score: 0,
        slots: 0,
        warmth: 0,
        admissible: false,
        note: option.warmth.unavailable,
        preference: 0,
        queue: 0,
      };
    }
    const fresh =
      report !== null &&
      now - option.receivedAt <= PLACEMENT_REPORT_FRESH_MS &&
      option.receivedAt <= now + 5_000;
    if (!fresh) {
      return {
        ...base,
        score: 0,
        slots: 0,
        warmth: option.warmth,
        admissible: false,
        note: "sent no recent load report",
        preference: 0,
        queue: 0,
      };
    }
    const weight = report.weight ?? 0;
    if (weight <= 0) {
      return {
        ...base,
        score: 0,
        slots: 0,
        warmth: option.warmth,
        admissible: false,
        note: "takes no placed work",
        preference: 0,
        queue: 0,
      };
    }
    const { slots, preference, note } = freeAgentSlots({
      resources: report.resources,
      runningAgents: report.runningAgents,
      launchesInFlight: report.launchesInFlight + report.waiting + option.sentLaunches,
      agentLimit: report.agentLimit,
      updating: report.updating,
    });
    const score = weight * preference * option.warmth;
    return {
      ...base,
      score,
      slots,
      warmth: option.warmth,
      admissible: slots >= 1,
      note: note ?? (option.warmth < 1 ? "has no copy of the repository yet" : null),
      // A thread waits for room there only where it can start right after the release lands; a
      // clone would begin before the wait, and the restart could cut it off.
      preference: report.updating === true && option.warmth < 1 ? 0 : weight * option.warmth,
      queue: report.waiting + option.sentLaunches,
    };
  });
  const candidates = scored.map(
    ({ preference: _preference, queue: _queue, ...candidate }) => candidate,
  );
  const best = scored.reduce<(typeof scored)[number] | null>(
    (top, candidate) =>
      candidate.admissible && candidate.score > (top?.score ?? 0) ? candidate : top,
    null,
  );
  // The machine the thread would go to if every machine were idle.
  const preferred = scored.reduce<(typeof scored)[number] | null>(
    (top, candidate) =>
      candidate.preference > 0 &&
      (top === null ||
        candidate.preference / (1 + candidate.queue) > top.preference / (1 + top.queue))
        ? candidate
        : top,
    null,
  );
  if (best !== null) {
    const chosen = candidates[scored.indexOf(best)]!;
    const passedOver =
      preferred !== null && preferred !== best && preferred.note !== null ? preferred : null;
    return {
      chosen,
      wait: false,
      reason:
        passedOver === null
          ? `${Math.floor(best.slots)} free agent ${Math.floor(best.slots) === 1 ? "slot" : "slots"}`
          : `${passedOver.label} ${passedOver.note}`,
      candidates,
    };
  }
  if (preferred === null) return null;
  return {
    chosen: candidates[scored.indexOf(preferred)]!,
    wait: true,
    reason:
      preferred.note === null
        ? "no machine has room"
        : `no machine has room; ${preferred.label} ${preferred.note}`,
    candidates,
  };
}
