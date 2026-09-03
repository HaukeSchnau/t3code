import type {
  DesktopBridge,
  DesktopEnergyProcessSnapshot,
  DesktopIpcMessagePressureSnapshot,
  ServerProcessDiagnosticsResult,
  ServerProcessResourceHistoryResult,
  ServerTraceDiagnosticsResult,
} from "@t3tools/contracts";

export interface EnergyRendererLongTaskSample {
  readonly name: string;
  readonly startedAtMs: number;
  readonly durationMs: number;
}

export interface EnergyRendererCommitSample {
  readonly surface: string;
  readonly phase: "mount" | "update" | "nested-update";
  readonly actualDurationMs: number;
  readonly baseDurationMs: number;
  readonly startTimeMs: number;
  readonly commitTimeMs: number;
}

export interface EnergyRecurringWorkSample {
  readonly name: string;
  readonly owner: string;
  readonly active: boolean;
  readonly tickCount: number;
  readonly failureCount: number;
  readonly lastTickAtIso: string | null;
  readonly lastDurationMs: number | null;
}

export interface EnergyDiagnosticsServerSnapshot {
  readonly traceDiagnostics: ServerTraceDiagnosticsResult | null;
  readonly processDiagnostics: ServerProcessDiagnosticsResult | null;
  readonly processResourceHistory: ServerProcessResourceHistoryResult | null;
}

export interface EnergyDiagnosticsCaptureArtifact {
  readonly schemaVersion: 1;
  readonly capturedAtIso: string;
  readonly durationMs: number;
  readonly route: {
    readonly pathname: string;
    readonly visibilityState: string;
    readonly userAgent: string;
  };
  readonly server: {
    readonly before: EnergyDiagnosticsServerSnapshot;
    readonly after: EnergyDiagnosticsServerSnapshot;
  };
  readonly desktop: {
    readonly available: boolean;
    readonly processSnapshots: readonly DesktopEnergyProcessSnapshot[];
    readonly ipcPressureSnapshots: readonly DesktopIpcMessagePressureSnapshot[];
  };
  readonly renderer: {
    readonly longTasks: readonly EnergyRendererLongTaskSample[];
    readonly commits: readonly EnergyRendererCommitSample[];
  };
  readonly recurringWork: readonly EnergyRecurringWorkSample[];
}

export interface EnergyDiagnosticsCaptureResult {
  readonly artifact: EnergyDiagnosticsCaptureArtifact;
  readonly artifactPath: string | null;
}

interface ActiveRendererCapture {
  readonly startedAtMs: number;
  readonly longTasks: EnergyRendererLongTaskSample[];
  readonly commits: EnergyRendererCommitSample[];
  readonly observers: PerformanceObserver[];
}

let activeRendererCapture: ActiveRendererCapture | null = null;

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, durationMs));
}

function nowIso(): string {
  return new Date().toISOString();
}

function safeJsonStringify(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function buildRouteMetadata() {
  return {
    pathname: window.location.pathname,
    visibilityState: document.visibilityState,
    userAgent: window.navigator.userAgent,
  };
}

function startRendererCapture(): ActiveRendererCapture {
  const capture: ActiveRendererCapture = {
    startedAtMs: performance.now(),
    longTasks: [],
    commits: [],
    observers: [],
  };
  activeRendererCapture = capture;

  if ("PerformanceObserver" in window) {
    try {
      const longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          capture.longTasks.push({
            name: entry.name,
            startedAtMs: entry.startTime,
            durationMs: entry.duration,
          });
        }
      });
      longTaskObserver.observe({ entryTypes: ["longtask"] });
      capture.observers.push(longTaskObserver);
    } catch {
      // Some browser engines do not expose longtask entries. The capture should
      // still succeed with process, IPC, and React commit data.
    }
  }

  return capture;
}

function stopRendererCapture(capture: ActiveRendererCapture) {
  if (activeRendererCapture === capture) {
    activeRendererCapture = null;
  }
  for (const observer of capture.observers) {
    observer.disconnect();
  }
}

export function recordEnergyRendererCommit(sample: EnergyRendererCommitSample): void {
  activeRendererCapture?.commits.push(sample);
}

async function sampleDesktopBridge(input: {
  readonly bridge: DesktopBridge | undefined;
  readonly durationMs: number;
  readonly processSnapshots: DesktopEnergyProcessSnapshot[];
  readonly ipcSnapshots: DesktopIpcMessagePressureSnapshot[];
  readonly recurringWork: EnergyRecurringWorkSample[];
}): Promise<void> {
  const diagnostics = input.bridge?.energyDiagnostics;
  if (!diagnostics) {
    return;
  }

  const intervalMs = 1_000;
  const startedAt = performance.now();
  let tickCount = 0;
  let failureCount = 0;
  let lastTickAtIso: string | null = null;
  let lastDurationMs: number | null = null;

  while (performance.now() - startedAt < input.durationMs) {
    const tickStartedAt = performance.now();
    tickCount += 1;
    try {
      const [processSnapshot, ipcSnapshot] = await Promise.all([
        diagnostics.captureProcessSnapshot(),
        Promise.resolve(diagnostics.readIpcMessagePressureSnapshot()),
      ]);
      input.processSnapshots.push(processSnapshot);
      input.ipcSnapshots.push(ipcSnapshot);
      lastTickAtIso = nowIso();
      lastDurationMs = performance.now() - tickStartedAt;
    } catch {
      failureCount += 1;
      lastTickAtIso = nowIso();
      lastDurationMs = performance.now() - tickStartedAt;
    }

    const elapsed = performance.now() - startedAt;
    const remaining = input.durationMs - elapsed;
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
  }

  input.recurringWork.push({
    name: "energy.capture.desktop-sampler",
    owner: "DiagnosticsCaptureRecorder",
    active: false,
    tickCount,
    failureCount,
    lastTickAtIso,
    lastDurationMs,
  });
}

export async function recordEnergyDiagnosticsCapture(input: {
  readonly durationMs: number;
  readonly bridge: DesktopBridge | undefined;
  readonly readServerSnapshot: () =>
    | EnergyDiagnosticsServerSnapshot
    | Promise<EnergyDiagnosticsServerSnapshot>;
  readonly refreshServerDiagnostics: () => void | Promise<void>;
}): Promise<EnergyDiagnosticsCaptureResult> {
  if (activeRendererCapture !== null) {
    throw new Error("An energy diagnostics capture is already running in this renderer.");
  }

  const durationMs = Math.max(1_000, input.durationMs);
  const capturedAtIso = nowIso();
  const rendererCapture = startRendererCapture();
  const processSnapshots: DesktopEnergyProcessSnapshot[] = [];
  const ipcPressureSnapshots: DesktopIpcMessagePressureSnapshot[] = [];
  const recurringWork: EnergyRecurringWorkSample[] = [];
  try {
    const serverBefore = await input.readServerSnapshot();

    await input.refreshServerDiagnostics();
    await sampleDesktopBridge({
      bridge: input.bridge,
      durationMs,
      processSnapshots,
      ipcSnapshots: ipcPressureSnapshots,
      recurringWork,
    });
    await input.refreshServerDiagnostics();
    await sleep(250);
    const serverAfter = await input.readServerSnapshot();

    const artifact: EnergyDiagnosticsCaptureArtifact = {
      schemaVersion: 1,
      capturedAtIso,
      durationMs,
      route: buildRouteMetadata(),
      server: {
        before: serverBefore,
        after: serverAfter,
      },
      desktop: {
        available: Boolean(input.bridge?.energyDiagnostics),
        processSnapshots,
        ipcPressureSnapshots,
      },
      renderer: {
        longTasks: rendererCapture.longTasks,
        commits: rendererCapture.commits,
      },
      recurringWork,
    };

    const writer = input.bridge?.energyDiagnostics?.writeCaptureArtifact;
    if (!writer) {
      return { artifact, artifactPath: null };
    }

    const result = await writer({ artifactJson: safeJsonStringify(artifact) });
    return {
      artifact,
      artifactPath: result.path,
    };
  } finally {
    stopRendererCapture(rendererCapture);
  }
}
