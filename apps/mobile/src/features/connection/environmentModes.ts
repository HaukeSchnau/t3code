import { useAtomValue } from "@effect/atom-react";
import {
  activeEnvironmentMode,
  environmentModeLabel,
  type EnvironmentModeSelection,
} from "@t3tools/client-runtime/connection";

import { environmentCatalog } from "../../connection/catalog";
import { useAtomCommand } from "../../state/use-atom-command";

const ALL_ID = "all";

/** Menu actions for switching modes; ids are mode ids, with `"all"` for every environment. */
export function useEnvironmentModeMenu() {
  const modes = useAtomValue(environmentCatalog.modesValueAtom);
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const applyMode = useAtomCommand(environmentCatalog.applyMode, "environment mode");
  const active = activeEnvironmentMode(modes, catalog.entries);
  const selections: EnvironmentModeSelection[] = [...modes.map((mode) => mode.id), null];
  return {
    visible: modes.length > 0,
    label: environmentModeLabel(modes, active),
    actions: selections.map((selection) => ({
      id: selection ?? ALL_ID,
      title: environmentModeLabel(modes, selection),
      state: selection === active ? ("on" as const) : ("off" as const),
    })),
    select: (id: string) => void applyMode(id === ALL_ID ? null : id),
  };
}
