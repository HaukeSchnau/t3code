import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentMode } from "@t3tools/client-runtime/connection";
import { msg, T, useGT, useMessages } from "gt-react-native";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { environmentCatalog } from "../../connection/catalog";
import { uuidv4 } from "../../lib/uuid";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";

const SUGGESTED_NAMES = [
  msg("Work", { $context: "suggested environment mode name" }),
  msg("Personal", { $context: "suggested environment mode name" }),
];

export function EnvironmentModesSettings() {
  const gt = useGT();
  const messages = useMessages();
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const modes = useAtomValue(environmentCatalog.modesValueAtom);
  const setModes = useAtomCommand(environmentCatalog.setModes, { reportFailure: false });
  const [expanded, setExpanded] = useState<string | null>(null);
  if (catalog.entries.size === 0 && modes.length === 0) return null;

  const save = (
    transform: (current: ReadonlyArray<EnvironmentMode>) => ReadonlyArray<EnvironmentMode>,
  ) =>
    void setModes(transform).then((result) => {
      if (result._tag === "Failure") Dialog.alert(gt("Could not save environment modes"));
    });
  const update = (id: string, change: (mode: EnvironmentMode) => EnvironmentMode) =>
    save((current) => current.map((mode) => (mode.id === id ? change(mode) : mode)));
  const addMode = () => {
    const mode = {
      id: uuidv4(),
      name: messages(
        SUGGESTED_NAMES[modes.length] ??
          msg("Mode {number}", {
            number: modes.length + 1,
            $context: "default environment mode name",
          }),
      ),
      environmentIds: [],
    };
    save((current) => [...current, mode]);
    setExpanded(mode.id);
  };

  return (
    <View className="mt-5 gap-3">
      <SettingsSection title={gt("Modes", { $context: "environment modes" })}>
        {modes.map((mode) => {
          const memberCount = mode.environmentIds.filter((id) => catalog.entries.has(id)).length;
          return (
            <View key={mode.id}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={gt("{mode} mode", { mode: mode.name })}
                accessibilityState={{ expanded: expanded === mode.id }}
                className="flex-row items-center gap-3 p-4"
                onPress={() => setExpanded(expanded === mode.id ? null : mode.id)}
              >
                <Text className="min-w-0 flex-1 text-base font-t3-bold text-foreground">
                  {mode.name}
                </Text>
                <Text className="text-sm text-foreground-muted">
                  {gt("{count, plural, one {{count} environment} other {{count} environments}}", {
                    count: memberCount,
                  })}
                </Text>
                <SymbolView
                  name={expanded === mode.id ? "chevron.up" : "chevron.down"}
                  size={12}
                  tintColorClassName="accent-icon-muted"
                />
              </Pressable>
              {expanded === mode.id ? (
                <>
                  {[...catalog.entries.values()].map((entry) => {
                    const environmentId = entry.target.environmentId;
                    const member = mode.environmentIds.includes(environmentId);
                    return (
                      <ListChoiceRow
                        key={environmentId}
                        label={entry.target.label}
                        selected={member}
                        onPress={() =>
                          update(mode.id, (current) => ({
                            ...current,
                            environmentIds: member
                              ? current.environmentIds.filter((id) => id !== environmentId)
                              : [...current.environmentIds, environmentId],
                          }))
                        }
                      />
                    );
                  })}
                  <View className="flex-row gap-4 px-4 pb-4 pt-2">
                    <Pressable
                      accessibilityRole="button"
                      onPress={() =>
                        Dialog.prompt({
                          title: gt("Rename mode"),
                          initialValue: mode.name,
                          confirmText: gt("Save"),
                          onConfirm: (value) => {
                            const name = value.trim();
                            if (name.length > 0)
                              update(mode.id, (current) => ({ ...current, name }));
                          },
                        })
                      }
                    >
                      <Text className="text-sm font-t3-bold text-foreground">
                        {gt("Rename", { $context: "verb, renames an environment mode" })}
                      </Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() =>
                        save((current) => current.filter((candidate) => candidate.id !== mode.id))
                      }
                    >
                      <Text className="text-sm font-t3-bold text-danger-foreground">
                        {gt("Remove", { $context: "verb, removes an environment mode" })}
                      </Text>
                    </Pressable>
                  </View>
                </>
              ) : null}
            </View>
          );
        })}
        <Pressable accessibilityRole="button" className="p-4" onPress={addMode}>
          <Text className="text-base text-foreground">
            <T>Add mode</T>
          </Text>
        </Pressable>
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        <T>
          A mode turns its environments on and turns off environments that only other modes include.
          Switch modes from the thread list. Modes apply only to this device.
        </T>
      </Text>
    </View>
  );
}
