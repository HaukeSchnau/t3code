import type { DesktopDictationPill } from "@t3tools/contracts";
import { contextBridge, ipcRenderer } from "electron";

import { DICTATION_PILL_CLICK_CHANNEL, DICTATION_PILL_STATE_CHANNEL } from "./ipc/channels.ts";

contextBridge.exposeInMainWorld("dictationPill", {
  onState: (listener: (pill: DesktopDictationPill) => void) => {
    ipcRenderer.on(DICTATION_PILL_STATE_CHANNEL, (_event, pill: unknown) => {
      if (typeof pill === "object" && pill !== null) listener(pill as DesktopDictationPill);
    });
  },
  click: () => ipcRenderer.send(DICTATION_PILL_CLICK_CHANNEL),
});
