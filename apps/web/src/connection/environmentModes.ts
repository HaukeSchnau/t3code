import { useAtomValue } from "@effect/atom-react";
import {
  activeEnvironmentMode,
  environmentModeLabel,
  type EnvironmentModeSelection,
} from "@t3tools/client-runtime/connection";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";

import { toastManager } from "~/components/ui/toast";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentCatalog } from "./catalog";

export function useEnvironmentModes() {
  const modes = useAtomValue(environmentCatalog.modesValueAtom);
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const active = activeEnvironmentMode(modes, catalog.entries);
  return { modes, active, activeLabel: environmentModeLabel(modes, active) };
}

/** Applies a mode, or with `"next"` cycles to the one after the active mode, and names the result. */
export async function applyEnvironmentMode(
  selection: EnvironmentModeSelection | "next",
): Promise<void> {
  const modes = appAtomRegistry.get(environmentCatalog.modesValueAtom);
  if (modes.length === 0) {
    toastManager.add({
      id: "environment-mode",
      title: "No environment modes yet",
      description: "Create them in Settings, Connections.",
    });
    return;
  }
  const result = await runAtomCommand(appAtomRegistry, environmentCatalog.applyMode, selection, {
    reportFailure: false,
  });
  toastManager.add(
    result._tag === "Success"
      ? {
          id: "environment-mode",
          title: `Mode: ${environmentModeLabel(modes, result.value)}`,
          timeout: 1500,
        }
      : { id: "environment-mode", type: "error", title: "Could not switch environment mode" },
  );
}
