import type {
  DesktopDictationBridge,
  DesktopDictationStatus,
  DictationKey,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { isMacPlatform } from "../../lib/utils";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

const KEY_LABELS: Record<DictationKey, string> = {
  off: "Off",
  fn: "Fn (Globe)",
  "right-option": "Right Option",
  "right-command": "Right Command",
};

/** The macOS desktop app's dictation key, which also works outside T3 when allowed. */
export function DictationKeySettings() {
  const dictation =
    typeof window === "undefined" || !isMacPlatform(navigator.platform)
      ? undefined
      : window.desktopBridge?.dictation;
  if (!dictation) return null;
  return <DictationKeyRows dictation={dictation} />;
}

function DictationKeyRows({ dictation }: { readonly dictation: DesktopDictationBridge }) {
  const searchableSetting = useSearchableSetting();
  const key = useClientSettings((settings) => settings.dictationKey);
  const inOtherApps = useClientSettings((settings) => settings.dictationInOtherApps);
  const readsField = useClientSettings((settings) => settings.dictationReadsField);
  const [status, setStatus] = useState<DesktopDictationStatus | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads macOS permission and Globe key state, refreshed when the person returns from System Settings
  useEffect(() => {
    let disposed = false;
    const refresh = () =>
      void dictation
        .getStatus()
        .then((next) => {
          if (!disposed) setStatus(next);
        })
        .catch(() => undefined);
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      disposed = true;
      window.removeEventListener("focus", refresh);
    };
  }, [dictation]);

  const globeWarning =
    key === "fn" && status && status.globeKey !== "none"
      ? `macOS also acts on the Globe key. In System Settings › Keyboard, set "Press 🌐 key to" to "Do Nothing".`
      : null;

  return (
    <>
      <SettingsRow
        {...searchableSetting("dictation-key")}
        title="Dictation key"
        description="Dictate with one key, in T3 and, if allowed, in other apps. It follows the shortcut mode above. Add Shift to save a new draft thread, or Control to speak an instruction that rewrites the selection."
        status={status?.message ?? globeWarning}
        control={
          <Select
            value={key}
            onValueChange={(value) => {
              if (!value) return;
              // The Globe key warning only applies to Fn, so read the status again.
              void updateClientSettings({ dictationKey: value as DictationKey })
                .then(() => dictation.getStatus())
                .then(setStatus)
                .catch(() => undefined);
            }}
          >
            <SelectTrigger size="sm" aria-label="Dictation key" className="max-w-72">
              <SelectValue>{KEY_LABELS[key]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(Object.keys(KEY_LABELS) as DictationKey[]).map((option) => (
                <SelectItem key={option} value={option}>
                  {KEY_LABELS[option]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {key === "off" ? null : (
        <SettingsRow
          {...searchableSetting("dictation-in-other-apps")}
          title="Use the key in other apps"
          description="Text lands where you started: pasted at the cursor of that app, or copied if you moved on. Keep T3's window open."
          status={
            inOtherApps && status && !status.accessibility
              ? "T3 Code needs Accessibility permission to paste into other apps."
              : null
          }
          control={
            <div className="flex items-center gap-2">
              {inOtherApps && status && !status.accessibility ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void dictation.requestAccessibility()}
                >
                  Allow
                </Button>
              ) : null}
              <Switch
                checked={inOtherApps}
                aria-label="Use the dictation key in other apps"
                onCheckedChange={(checked) =>
                  void updateClientSettings({ dictationInOtherApps: checked })
                }
              />
            </div>
          }
        />
      )}
      {key !== "off" && inOtherApps ? (
        <SettingsRow
          {...searchableSetting("dictation-reads-field")}
          title="Read the text around the cursor"
          description="Sends up to about 1 KB around your cursor in the other app to transcript cleanup. Mac apps share it; most browsers and Electron apps don't, and password fields never do."
          control={
            <Switch
              checked={readsField}
              aria-label="Read the text around the cursor"
              onCheckedChange={(checked) =>
                void updateClientSettings({ dictationReadsField: checked })
              }
            />
          }
        />
      ) : null}
    </>
  );
}
