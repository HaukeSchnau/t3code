import {
  DesktopEnergyDiagnosticsCaptureWriteInputSchema,
  DesktopEnergyDiagnosticsCaptureWriteResultSchema,
  DesktopEnergyProcessSnapshotSchema,
  type DesktopEnergyProcessSample,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Electron from "electron";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const RevealCaptureArtifactInput = Schema.String;

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function sanitizeArtifactTimestamp(timestamp: string): string {
  return timestamp.replace(/[:.]/g, "-");
}

function buildWebContentsByPid() {
  const result = new Map<
    number,
    {
      readonly id: number;
      readonly type: string | null;
      readonly url: string | null;
      readonly title: string | null;
    }
  >();

  for (const contents of Electron.webContents.getAllWebContents()) {
    const getOSProcessId = contents.getOSProcessId?.bind(contents);
    const pid = typeof getOSProcessId === "function" ? getOSProcessId() : undefined;
    if (typeof pid !== "number" || pid <= 0) continue;
    result.set(pid, {
      id: contents.id,
      type: stringOrNull(contents.getType?.()),
      url: stringOrNull(contents.getURL?.()),
      title: stringOrNull(contents.getTitle?.()),
    });
  }

  return result;
}

function processMetricToSample(input: {
  readonly sampledAtIso: string;
  readonly metric: Electron.ProcessMetric;
  readonly webContentsByPid: ReturnType<typeof buildWebContentsByPid>;
}): DesktopEnergyProcessSample {
  const metric = input.metric;
  const cpu = metric.cpu as Electron.CPUUsage & {
    readonly percentCPU?: unknown;
    readonly percentCPUUsage?: unknown;
  };
  const memory = metric.memory as Electron.MemoryInfo & {
    readonly sharedBytes?: unknown;
  };
  const webContents = input.webContentsByPid.get(metric.pid) ?? null;
  return {
    sampledAtIso: input.sampledAtIso,
    pid: metric.pid,
    type: stringOrNull(metric.type) ?? "unknown",
    name: stringOrNull(metric.name),
    serviceName: stringOrNull(metric.serviceName),
    cpuPercent: numberOrNull(cpu.percentCPUUsage ?? cpu.percentCPU),
    idleWakeupsPerSecond: numberOrNull(cpu.idleWakeupsPerSecond),
    workingSetBytes: numberOrNull(memory.workingSetSize),
    peakWorkingSetBytes: numberOrNull(memory.peakWorkingSetSize),
    privateBytes: numberOrNull(memory.privateBytes),
    sharedBytes: numberOrNull(memory.sharedBytes),
    sandboxed: booleanOrNull(metric.sandboxed),
    integrityLevel: stringOrNull(metric.integrityLevel),
    webContentsId: webContents?.id ?? null,
    webContentsType: webContents?.type ?? null,
    webContentsUrl: webContents?.url ?? null,
    webContentsTitle: webContents?.title ?? null,
  };
}

export const captureEnergyProcessSnapshot = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.ENERGY_CAPTURE_PROCESS_SNAPSHOT_CHANNEL,
  payload: Schema.Void,
  result: DesktopEnergyProcessSnapshotSchema,
  handler: Effect.fn("desktop.ipc.energyDiagnostics.captureProcessSnapshot")(function* () {
    const sampledAtIso = DateTime.formatIso(yield* DateTime.now);
    return yield* Effect.sync(() => {
      const webContentsByPid = buildWebContentsByPid();
      return {
        sampledAtIso,
        processes: Electron.app.getAppMetrics().map((metric) =>
          processMetricToSample({
            sampledAtIso,
            metric,
            webContentsByPid,
          }),
        ),
      };
    });
  }),
});

export const writeEnergyCaptureArtifact = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.ENERGY_WRITE_CAPTURE_ARTIFACT_CHANNEL,
  payload: DesktopEnergyDiagnosticsCaptureWriteInputSchema,
  result: DesktopEnergyDiagnosticsCaptureWriteResultSchema,
  handler: Effect.fn("desktop.ipc.energyDiagnostics.writeCaptureArtifact")(function* (input) {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const capturedAtIso = DateTime.formatIso(yield* DateTime.now);
    const directory = environment.path.join(environment.logDir, "energy-diagnostics");
    const filePath = environment.path.join(
      directory,
      `energy-capture-${sanitizeArtifactTimestamp(capturedAtIso)}.json`,
    );

    yield* fileSystem.makeDirectory(directory, { recursive: true });
    yield* fileSystem.writeFileString(filePath, `${input.artifactJson}\n`);
    return { path: filePath };
  }),
});

export const revealEnergyCaptureArtifact = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.ENERGY_REVEAL_CAPTURE_ARTIFACT_CHANNEL,
  payload: RevealCaptureArtifactInput,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.energyDiagnostics.revealCaptureArtifact")(function* (path) {
    yield* Effect.sync(() => {
      Electron.shell.showItemInFolder(path);
    });
  }),
});
