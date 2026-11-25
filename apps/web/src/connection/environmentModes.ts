import { useAtomValue } from "@effect/atom-react";
import {
  activeEnvironmentMode,
  environmentModeLabel,
  type EnvironmentModeSelection,
} from "@t3tools/client-runtime/connection";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { msg, useMessages } from "gt-react";

import { toastManager } from "~/components/ui/toast";
import { m } from "~/i18n/messages";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentCatalog } from "./catalog";

export function useEnvironmentModes() {
  const resolve = useMessages();
  const modes = useAtomValue(environmentCatalog.modesValueAtom);
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const active = activeEnvironmentMode(modes, catalog.entries);
  return { modes, active, activeLabel: environmentModeLabel(modes, active, resolve) };
}

/** Applies a mode, or with `"next"` cycles to the one after the active mode, and names the result. */
export async function applyEnvironmentMode(
  selection: EnvironmentModeSelection | "next",
): Promise<void> {
  const modes = appAtomRegistry.get(environmentCatalog.modesValueAtom);
  if (modes.length === 0) {
    toastManager.add({
      id: "environment-mode",
      title: m(msg("No environment modes yet")),
      description: m(msg("Create them in Settings, Connections.")),
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
          title: m(msg("Mode: {mode}", { mode: environmentModeLabel(modes, result.value, m) })),
          timeout: 1500,
        }
      : {
          id: "environment-mode",
          type: "error",
          title: m(msg("Could not switch environment mode")),
        },
  );
}
