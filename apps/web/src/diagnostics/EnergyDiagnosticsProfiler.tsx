import { Profiler, type ReactNode } from "react";

import { recordEnergyRendererCommit } from "./energyDiagnosticsCapture";

export function EnergyDiagnosticsProfiler({ id, children }: { id: string; children: ReactNode }) {
  return (
    <Profiler
      id={id}
      onRender={(surface, phase, actualDuration, baseDuration, startTime, commitTime) => {
        recordEnergyRendererCommit({
          surface,
          phase,
          actualDurationMs: actualDuration,
          baseDurationMs: baseDuration,
          startTimeMs: startTime,
          commitTimeMs: commitTime,
        });
      }}
    >
      {children}
    </Profiler>
  );
}
