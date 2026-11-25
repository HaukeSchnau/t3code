import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { useGT } from "gt-react";

import { DraftInput } from "../ui/draft-input";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

function parseRemotes(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((remote) => remote.trim())
        .filter((remote) => remote.length > 0),
    ),
  ];
}

/** The jj trailer rows of the source control defaults (patches/jujutsu.md). */
export function JjCommitTrailerRows() {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const { scope } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixedTrailers = useScopedSettingsMixed(["jjCommitTrailers"]);
  const mixedStripRemotes = useScopedSettingsMixed(["jjStripTrailersRemotes"]);
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const stripRemotes = settings.jjStripTrailersRemotes.join(", ");

  return (
    <>
      <SettingsRow
        serverScoped
        settingKeys={["jjCommitTrailers"]}
        mixed={mixedTrailers}
        {...searchableSetting("jj-commit-trailers")}
        description={
          isProjectScope
            ? gt(
                "Commits that agents or T3 make in this jj repository get T3-Thread and T3-Turn trailers that link them to the thread and turn.",
              )
            : gt(
                "Commits that agents or T3 make in jj repositories get T3-Thread and T3-Turn trailers that link them to the thread and turn. Projects can override it.",
              )
        }
        resetAction={
          settings.jjCommitTrailers !== DEFAULT_SERVER_SETTINGS.jjCommitTrailers ? (
            <SettingResetButton
              ariaLabel={gt("Reset jj commit trailers to default")}
              onClick={() =>
                updateSettings({ jjCommitTrailers: DEFAULT_SERVER_SETTINGS.jjCommitTrailers })
              }
            />
          ) : null
        }
        control={
          <Switch
            aria-label={gt("Add T3 trailers to jj commits")}
            mixed={mixedTrailers}
            checked={mixedTrailers ? false : settings.jjCommitTrailers}
            onCheckedChange={(enabled) => updateSettings({ jjCommitTrailers: enabled })}
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["jjStripTrailersRemotes"]}
        mixed={mixedStripRemotes}
        {...searchableSetting("jj-strip-trailers-remotes")}
        description={
          isProjectScope
            ? gt(
                "Pushes from this project to these remotes drop the T3 trailers first. Separate remote names with commas.",
              )
            : gt(
                "Pushes to these remotes drop the T3 trailers first. Separate remote names with commas. Projects can override it.",
              )
        }
        resetAction={
          settings.jjStripTrailersRemotes.length > 0 ? (
            <SettingResetButton
              ariaLabel={gt("Reset remotes that strip T3 trailers to default")}
              onClick={() => updateSettings({ jjStripTrailersRemotes: [] })}
            />
          ) : null
        }
        control={
          <DraftInput
            size="settings"
            className="w-full sm:w-72"
            value={mixedStripRemotes ? "" : stripRemotes}
            onCommit={(next) => {
              const remotes = parseRemotes(next);
              if (mixedStripRemotes || remotes.join(", ") !== stripRemotes) {
                updateSettings({ jjStripTrailersRemotes: remotes });
              }
            }}
            placeholder={
              mixedStripRemotes
                ? gt("Mixed", { $context: "projects have different values" })
                : gt("No remotes")
            }
            autoCapitalize="none"
            spellCheck={false}
            aria-label={gt("Strip T3 trailers when pushing to")}
          />
        }
      />
    </>
  );
}
