import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentMode } from "@t3tools/client-runtime/connection";
import { PlusIcon, Trash2Icon } from "lucide-react";

import { environmentCatalog } from "~/connection/catalog";
import { shortcutLabelForCommand } from "~/keybindings";
import { randomUUID } from "~/lib/utils";
import type { EnvironmentPresentation } from "~/state/environments";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { Toggle } from "../ui/toggle";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { searchableSetting } from "./settingsSearch";

const SUGGESTED_NAMES = ["Work", "Personal"];

export function EnvironmentModesSettings({
  environments,
}: {
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
}) {
  const modes = useAtomValue(environmentCatalog.modesValueAtom);
  const setModes = useAtomCommand(environmentCatalog.setModes, { reportFailure: false });
  const shortcutLabel = shortcutLabelForCommand(
    useAtomValue(primaryServerKeybindingsAtom),
    "environments.cycleMode",
  );

  if (environments.length === 0 && modes.length === 0) return null;

  const save = (
    transform: (current: ReadonlyArray<EnvironmentMode>) => ReadonlyArray<EnvironmentMode>,
  ) =>
    void setModes(transform).then((result) => {
      if (result._tag === "Failure")
        toastManager.add({ type: "error", title: "Could not save environment modes" });
    });
  const update = (id: string, change: (mode: EnvironmentMode) => EnvironmentMode) =>
    save((current) => current.map((mode) => (mode.id === id ? change(mode) : mode)));

  const { id, title } = searchableSetting("environment-modes");
  return (
    <FoldedSettingsSection
      id={id}
      title={title}
      summary={modes.length === 0 ? "None" : modes.map((mode) => mode.name).join(", ")}
    >
      <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
        A mode turns its environments on and turns off environments that only other modes include.
        Environments in no mode keep their switch. Switch modes from the sidebar
        {shortcutLabel ? ` or cycle them with ${shortcutLabel}` : ""}. Modes apply only to this
        device.
      </p>
      {modes.map((mode) => (
        <div key={mode.id} className="flex flex-col gap-2 border-t px-3 py-2.5 sm:px-4">
          <div className="flex items-center gap-2">
            <Input
              size="sm"
              className="w-48"
              defaultValue={mode.name}
              aria-label="Mode name"
              onBlur={(event) => {
                const name = event.currentTarget.value.trim();
                if (name.length === 0) event.currentTarget.value = mode.name;
                else if (name !== mode.name) update(mode.id, (m) => ({ ...m, name }));
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
            <Button
              size="icon-xs"
              variant="ghost-destructive"
              aria-label={`Remove ${mode.name}`}
              onClick={() =>
                save((current) => current.filter((candidate) => candidate.id !== mode.id))
              }
            >
              <Trash2Icon />
            </Button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {environments.map((environment) => (
              <Toggle
                key={environment.environmentId}
                variant="outline"
                size="sm"
                pressed={mode.environmentIds.includes(environment.environmentId)}
                onPressedChange={(pressed) =>
                  update(mode.id, (m) => ({
                    ...m,
                    environmentIds: pressed
                      ? [...m.environmentIds, environment.environmentId]
                      : m.environmentIds.filter((value) => value !== environment.environmentId),
                  }))
                }
              >
                {environment.label}
              </Toggle>
            ))}
          </div>
        </div>
      ))}
      <div className="border-t px-3 py-2.5 sm:px-4">
        <Button
          size="xs"
          variant="ghost"
          onClick={() =>
            save((current) => [
              ...current,
              {
                id: randomUUID(),
                name: SUGGESTED_NAMES[current.length] ?? `Mode ${current.length + 1}`,
                environmentIds: [],
              },
            ])
          }
        >
          <PlusIcon />
          Add mode
        </Button>
      </div>
    </FoldedSettingsSection>
  );
}
