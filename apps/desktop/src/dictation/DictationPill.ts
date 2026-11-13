// @effect-diagnostics globalTimers:off -- The notice timer runs at Electron callback boundaries outside Effect fibers.

import type { DesktopDictationPill } from "@t3tools/contracts";
import * as Electron from "electron";

import { DICTATION_PILL_CLICK_CHANNEL, DICTATION_PILL_STATE_CHANNEL } from "../ipc/channels.ts";

const WIDTH = 360;
const HEIGHT = 48;
const BOTTOM_MARGIN = 28;
const NOTICE_MS = { info: 2_500, error: 4_000 } as const;

const PILL_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
    <style>
      html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; }
      body { display: flex; align-items: center; justify-content: center; font: 500 13px/1.2 -apple-system, system-ui, sans-serif; }
      #pill { display: inline-flex; align-items: center; gap: 10px; max-width: ${WIDTH - 16}px; height: 36px; padding: 0 14px;
        border-radius: 18px; background: rgba(24, 24, 27, 0.92); color: #f4f4f5; box-sizing: border-box;
        border: 1px solid rgba(255, 255, 255, 0.12); user-select: none; -webkit-user-select: none; }
      #pill.clickable { cursor: pointer; }
      #pill.error { color: #fca5a5; }
      #bars { display: inline-flex; align-items: center; gap: 2px; height: 16px; }
      #bars span { width: 3px; border-radius: 2px; background: #f4f4f5; min-height: 3px; }
      #label { color: #a1a1aa; white-space: nowrap; }
      #text { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; direction: rtl; text-align: left; }
      #text bdi { direction: ltr; }
      [hidden] { display: none !important; }
    </style>
  </head>
  <body>
    <div id="pill"><span id="bars"></span><span id="label"></span><span id="text"><bdi></bdi></span></div>
    <script>
      const pill = document.getElementById("pill");
      const bars = document.getElementById("bars");
      const label = document.getElementById("label");
      const text = document.querySelector("#text bdi");
      const weights = [0.5, 0.8, 1, 0.8, 0.5];
      for (const _ of weights) bars.appendChild(document.createElement("span"));
      const names = {
        dictate: ["Listening", "Transcribing"],
        draft: ["New draft", "Saving draft"],
        command: ["Instruction", "Rewriting"],
      };
      let clickable = false;
      pill.addEventListener("click", () => { if (clickable) window.dictationPill.click(); });
      window.dictationPill.onState((state) => {
        clickable = state.kind === "notice" && state.clickable;
        pill.className = (clickable ? "clickable " : "") + (state.kind === "notice" && state.tone === "error" ? "error" : "");
        bars.hidden = state.kind !== "listening";
        if (state.kind === "listening") {
          bars.childNodes.forEach((bar, index) => {
            bar.style.height = Math.round(3 + 13 * Math.min(1, state.level) * weights[index]) + "px";
          });
          label.textContent = names[state.gesture][0];
          text.textContent = state.preview ?? "";
        } else if (state.kind === "working") {
          label.textContent = names[state.gesture][1] + "…";
          text.textContent = "";
        } else {
          label.textContent = "";
          text.textContent = state.message;
        }
        label.hidden = label.textContent === "";
      });
    </script>
  </body>
</html>`;

/** A floating status pill that never takes focus, so the app being dictated into keeps it. */
export function createDictationPill(preloadPath: string, onClick: () => void) {
  let window: Electron.BrowserWindow | null = null;
  let loaded: Promise<void> | null = null;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;

  const onClickMessage = (event: Electron.IpcMainEvent) => {
    if (window && !window.isDestroyed() && event.sender === window.webContents) onClick();
  };
  Electron.ipcMain.on(DICTATION_PILL_CLICK_CHANNEL, onClickMessage);

  const ensure = () => {
    if (window && !window.isDestroyed()) return window;
    const created = new Electron.BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      type: "panel",
      webPreferences: {
        preload: preloadPath,
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    created.setAlwaysOnTop(true, "screen-saver");
    created.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
    loaded = created.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PILL_HTML)}`);
    window = created;
    return created;
  };

  const place = (target: Electron.BrowserWindow) => {
    const area = Electron.screen.getDisplayNearestPoint(
      Electron.screen.getCursorScreenPoint(),
    ).workArea;
    target.setBounds({
      x: Math.round(area.x + (area.width - WIDTH) / 2),
      y: Math.round(area.y + area.height - HEIGHT - BOTTOM_MARGIN),
      width: WIDTH,
      height: HEIGHT,
    });
  };

  const hide = () => {
    clearTimeout(noticeTimer);
    noticeTimer = undefined;
    if (window && !window.isDestroyed()) window.hide();
  };

  return {
    show(pill: DesktopDictationPill) {
      clearTimeout(noticeTimer);
      noticeTimer = undefined;
      const target = ensure();
      const clickable = pill.kind === "notice" && pill.clickable;
      target.setIgnoreMouseEvents(!clickable);
      if (!target.isVisible()) {
        place(target);
        target.showInactive();
      }
      void loaded?.then(() => {
        if (!target.isDestroyed()) target.webContents.send(DICTATION_PILL_STATE_CHANNEL, pill);
      });
      if (pill.kind === "notice") noticeTimer = setTimeout(hide, NOTICE_MS[pill.tone]);
    },
    hide,
    dispose() {
      hide();
      Electron.ipcMain.removeListener(DICTATION_PILL_CLICK_CHANNEL, onClickMessage);
      if (window && !window.isDestroyed()) window.destroy();
      window = null;
    },
  };
}
