import type { RunId, ThreadPlacement } from "@t3tools/contracts";

import type { EnvironmentThreadShell } from "./models.ts";

/**
 * A placed thread still waiting for room: its first run is preparing. A follow-up queued behind
 * it is not the active run, so Cancel names the waiting run and never stops the follow-up.
 */
export function placementWaitOf(
  shell: Pick<EnvironmentThreadShell, "placement" | "runtime">,
): { readonly placement: ThreadPlacement; readonly cancelRunId: RunId } | null {
  const placement = shell.placement;
  const runtime = shell.runtime;
  if (placement?.waitingSince == null || runtime?.status !== "preparing") return null;
  if (runtime.activeRunId === null) return null;
  return { placement, cancelRunId: runtime.activeRunId };
}
