import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentMode } from "@t3tools/client-runtime/connection";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { msg, T, useGT, useMessages, Var } from "gt-react";

import { environmentCatalog } from "~/connection/catalog";
import { shortcutLabelForCommand } from "~/keybindings";
import { m } from "~/i18n/messages";
import { randomUUID } from "~/lib/utils";
import type { EnvironmentPresentation } from "~/state/environments";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { toastManager } from "../ui/toast";
import { Toggle } from "../ui/toggle";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { SettingsNote } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

const SUGGESTED_NAMES = [
  msg("Work", { $context: "default name of an environment mode" }),
  msg("Personal", { $context: "default name of an environment mode" }),
];

export function EnvironmentModesSettings({
  environments,
}: {
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
}) {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const messages = useMessages();
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
        toastManager.add({ type: "error", title: m(msg("Could not save environment modes")) });
    });
  const update = (id: string, change: (mode: EnvironmentMode) => EnvironmentMode) =>
    save((current) => current.map((mode) => (mode.id === id ? change(mode) : mode)));

  const { id, title } = searchableSetting("environment-modes");
  return (
    <FoldedSettingsSection
      id={id}
      title={title}
      summary={
        modes.length === 0
          ? gt("None", { $context: "no environment modes" })
          : modes.map((mode) => mode.name).join(", ")
      }
    >
      <SettingsNote>
        {shortcutLabel ? (
          <T>
            A mode turns its environments on and turns off environments that only other modes
            include. Environments in no mode keep their switch. Switch modes from the sidebar or
            cycle them with <Var>{shortcutLabel}</Var>. Modes apply only to this device.
          </T>
        ) : (
          <T>
            A mode turns its environments on and turns off environments that only other modes
            include. Environments in no mode keep their switch. Switch modes from the sidebar. Modes
            apply only to this device.
          </T>
        )}
      </SettingsNote>
      {modes.map((mode) => (
        <div key={mode.id} className="flex flex-col gap-2 px-3 py-2.5 sm:px-4">
          <div className="flex items-center gap-2">
            <DraftInput
              size="settings"
              className="w-48"
              value={mode.name}
              aria-label={gt("Mode name")}
              onCommit={(next) => {
                const name = next.trim();
                if (name.length > 0 && name !== mode.name) update(mode.id, (m) => ({ ...m, name }));
              }}
            />
            <Button
              size="icon-xs"
              variant="ghost-destructive"
              aria-label={gt("Remove {name}", { name: mode.name })}
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
      <div className="px-3 py-2.5 sm:px-4">
        <Button
          size="xs"
          variant="ghost"
          onClick={() =>
            save((current) => [
              ...current,
              {
                id: randomUUID(),
                name: messages(
                  SUGGESTED_NAMES[current.length] ??
                    msg("Mode {number}", { number: current.length + 1 }),
                ),
                environmentIds: [],
              },
            ])
          }
        >
          <PlusIcon />
          <T>Add mode</T>
        </Button>
      </div>
    </FoldedSettingsSection>
  );
}
