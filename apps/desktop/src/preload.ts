// @effect-diagnostics globalDate:off - This sandboxed Electron preload cannot import Effect runtime modules.
import type {
  DesktopBridge,
  DesktopIpcMessagePressureCounter,
  DesktopIpcMessagePressureSnapshot,
  DesktopPreviewPointerEvent,
  DesktopPreviewRecordingFrame,
  DesktopPreviewTabState,
} from "@t3tools/contracts";
import { contextBridge, ipcRenderer } from "electron";

import * as IpcChannels from "./ipc/channels.ts";

interface IpcPressureAccumulator {
  readonly channel: string;
  readonly operation: "invoke" | "sendSync";
  count: number;
  totalDurationMs: number;
  maxDurationMs: number;
  estimatedPayloadBytes: number;
  failureCount: number;
}

const ipcPressureCounters = new Map<string, IpcPressureAccumulator>();

function estimatePayloadBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return 0;
  }
}

function recordIpcPressure(input: {
  readonly channel: string;
  readonly operation: "invoke" | "sendSync";
  readonly durationMs: number;
  readonly estimatedPayloadBytes: number;
  readonly failed: boolean;
}): void {
  const key = `${input.operation}:${input.channel}`;
  const current =
    ipcPressureCounters.get(key) ??
    ({
      channel: input.channel,
      operation: input.operation,
      count: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
      estimatedPayloadBytes: 0,
      failureCount: 0,
    } satisfies IpcPressureAccumulator);

  current.count += 1;
  current.totalDurationMs += input.durationMs;
  current.maxDurationMs = Math.max(current.maxDurationMs, input.durationMs);
  current.estimatedPayloadBytes += input.estimatedPayloadBytes;
  if (input.failed) current.failureCount += 1;
  ipcPressureCounters.set(key, current);
}

function readIpcMessagePressureSnapshot(): DesktopIpcMessagePressureSnapshot {
  const counters: DesktopIpcMessagePressureCounter[] = [...ipcPressureCounters.values()]
    .map((counter) => ({ ...counter }))
    .sort((left, right) => right.count - left.count || left.channel.localeCompare(right.channel));
  return {
    readAtIso: new Date().toISOString(),
    counters,
  };
}

async function invoke(channel: string, ...args: unknown[]) {
  const startedAt = performance.now();
  const estimatedBytes = estimatePayloadBytes(args);
  try {
    const result = await ipcRenderer.invoke(channel, ...args);
    recordIpcPressure({
      channel,
      operation: "invoke",
      durationMs: performance.now() - startedAt,
      estimatedPayloadBytes: estimatedBytes + estimatePayloadBytes(result),
      failed: false,
    });
    return result;
  } catch (error) {
    recordIpcPressure({
      channel,
      operation: "invoke",
      durationMs: performance.now() - startedAt,
      estimatedPayloadBytes: estimatedBytes,
      failed: true,
    });
    throw error;
  }
}

function sendSync(channel: string, ...args: unknown[]) {
  const startedAt = performance.now();
  const estimatedBytes = estimatePayloadBytes(args);
  try {
    const result = ipcRenderer.sendSync(channel, ...args);
    recordIpcPressure({
      channel,
      operation: "sendSync",
      durationMs: performance.now() - startedAt,
      estimatedPayloadBytes: estimatedBytes + estimatePayloadBytes(result),
      failed: false,
    });
    return result;
  } catch (error) {
    recordIpcPressure({
      channel,
      operation: "sendSync",
      durationMs: performance.now() - startedAt,
      estimatedPayloadBytes: estimatedBytes,
      failed: true,
    });
    throw error;
  }
}

// oxlint-disable-next-line t3code/no-global-process-runtime -- Electron exposes the client platform in its sandboxed preload process.
const clientPlatform = process.platform;

function unwrapEnsureSshEnvironmentResult(result: unknown) {
  if (
    typeof result === "object" &&
    result !== null &&
    "type" in result &&
    result.type === IpcChannels.SSH_PASSWORD_PROMPT_CANCELLED_RESULT
  ) {
    const message =
      "message" in result && typeof result.message === "string"
        ? result.message
        : "SSH authentication cancelled.";
    throw new Error(message);
  }
  return result as Awaited<ReturnType<DesktopBridge["ensureSshEnvironment"]>>;
}

contextBridge.exposeInMainWorld("desktopBridge", {
  getAppBranding: () => {
    const result = sendSync(IpcChannels.GET_APP_BRANDING_CHANNEL);
    if (typeof result !== "object" || result === null) {
      return null;
    }
    return result as ReturnType<DesktopBridge["getAppBranding"]>;
  },
  getClientPlatform: () => clientPlatform,
  getSystemLocale: () => {
    const result = ipcRenderer.sendSync(IpcChannels.GET_SYSTEM_LOCALE_CHANNEL);
    return typeof result === "string" ? result : null;
  },
  getLocalEnvironmentBootstraps: () => {
    const result = sendSync(IpcChannels.GET_LOCAL_ENVIRONMENT_BOOTSTRAPS_CHANNEL);
    if (!Array.isArray(result)) {
      return [];
    }
    return result as ReturnType<DesktopBridge["getLocalEnvironmentBootstraps"]>;
  },
  getLocalEnvironmentBearerToken: () =>
    invoke(IpcChannels.GET_LOCAL_ENVIRONMENT_BEARER_TOKEN_CHANNEL),
  getClientSettings: () => invoke(IpcChannels.GET_CLIENT_SETTINGS_CHANNEL),
  setClientSettings: (settings) => invoke(IpcChannels.SET_CLIENT_SETTINGS_CHANNEL, settings),
  getConnectionCatalog: () => invoke(IpcChannels.GET_CONNECTION_CATALOG_CHANNEL),
  setConnectionCatalog: (catalog) => invoke(IpcChannels.SET_CONNECTION_CATALOG_CHANNEL, catalog),
  clearConnectionCatalog: () => invoke(IpcChannels.CLEAR_CONNECTION_CATALOG_CHANNEL),
  discoverSshHosts: () => invoke(IpcChannels.DISCOVER_SSH_HOSTS_CHANNEL),
  ensureSshEnvironment: async (target, options) =>
    unwrapEnsureSshEnvironmentResult(
      await invoke(IpcChannels.ENSURE_SSH_ENVIRONMENT_CHANNEL, {
        target,
        ...(options === undefined ? {} : { options }),
      }),
    ),
  disconnectSshEnvironment: (target) =>
    invoke(IpcChannels.DISCONNECT_SSH_ENVIRONMENT_CHANNEL, target),
  fetchSshEnvironmentDescriptor: (httpBaseUrl) =>
    invoke(IpcChannels.FETCH_SSH_ENVIRONMENT_DESCRIPTOR_CHANNEL, { httpBaseUrl }),
  bootstrapSshBearerSession: (httpBaseUrl, credential) =>
    invoke(IpcChannels.BOOTSTRAP_SSH_BEARER_SESSION_CHANNEL, {
      httpBaseUrl,
      credential,
    }),
  fetchSshSessionState: (httpBaseUrl, bearerToken) =>
    invoke(IpcChannels.FETCH_SSH_SESSION_STATE_CHANNEL, { httpBaseUrl, bearerToken }),
  issueSshWebSocketTicket: (httpBaseUrl, bearerToken) =>
    invoke(IpcChannels.ISSUE_SSH_WEBSOCKET_TOKEN_CHANNEL, { httpBaseUrl, bearerToken }),
  onSshPasswordPrompt: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, request: unknown) => {
      if (typeof request !== "object" || request === null) return;
      listener(request as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(IpcChannels.SSH_PASSWORD_PROMPT_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.SSH_PASSWORD_PROMPT_CHANNEL, wrappedListener);
    };
  },
  resolveSshPasswordPrompt: (requestId, password) =>
    invoke(IpcChannels.RESOLVE_SSH_PASSWORD_PROMPT_CHANNEL, { requestId, password }),
  getServerExposureState: () => invoke(IpcChannels.GET_SERVER_EXPOSURE_STATE_CHANNEL),
  setServerExposureMode: (mode) => invoke(IpcChannels.SET_SERVER_EXPOSURE_MODE_CHANNEL, mode),
  setTailscaleServeEnabled: (input) =>
    invoke(IpcChannels.SET_TAILSCALE_SERVE_ENABLED_CHANNEL, input),
  getAdvertisedEndpoints: () => invoke(IpcChannels.GET_ADVERTISED_ENDPOINTS_CHANNEL),
  getWslState: () => invoke(IpcChannels.GET_WSL_STATE_CHANNEL),
  setWslBackendEnabled: (enabled) => invoke(IpcChannels.SET_WSL_BACKEND_ENABLED_CHANNEL, enabled),
  setWslDistro: (distro) => invoke(IpcChannels.SET_WSL_DISTRO_CHANNEL, distro),
  setWslOnly: (enabled) => invoke(IpcChannels.SET_WSL_ONLY_CHANNEL, enabled),
  pickFolder: (options) => invoke(IpcChannels.PICK_FOLDER_CHANNEL, options),
  pickProjectFavicon: (initialPath) =>
    invoke(IpcChannels.PICK_PROJECT_FAVICON_CHANNEL, initialPath),
  pickThemeFiles: () => invoke(IpcChannels.PICK_THEME_FILES_CHANNEL, undefined),
  setTheme: (theme) => invoke(IpcChannels.SET_THEME_CHANNEL, theme),
  showContextMenu: (items, position) =>
    invoke(IpcChannels.CONTEXT_MENU_CHANNEL, {
      items,
      ...(position === undefined ? {} : { position }),
    }),
  openExternal: (url: string) => invoke(IpcChannels.OPEN_EXTERNAL_CHANNEL, url),
  consumePendingOpenWorkspaceRequests: () =>
    invoke(IpcChannels.CONSUME_PENDING_OPEN_WORKSPACE_REQUESTS_CHANNEL),
  onOpenWorkspaceRequest: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, request: unknown) => {
      if (typeof request !== "object" || request === null) return;
      listener(request as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(IpcChannels.OPEN_WORKSPACE_REQUEST_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.OPEN_WORKSPACE_REQUEST_CHANNEL, wrappedListener);
    };
  },
  probeRemoteEditors: () => invoke(IpcChannels.PROBE_REMOTE_EDITORS_CHANNEL),
  onMenuAction: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, action: unknown) => {
      if (typeof action !== "string") return;
      listener(action);
    };

    ipcRenderer.on(IpcChannels.MENU_ACTION_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.MENU_ACTION_CHANNEL, wrappedListener);
    };
  },
  onQuitShortcut: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
      if (state !== "down" && state !== "up") return;
      listener(state);
    };

    ipcRenderer.on(IpcChannels.QUIT_SHORTCUT_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.QUIT_SHORTCUT_CHANNEL, wrappedListener);
    };
  },
  getWindowFullscreenState: () =>
    ipcRenderer.sendSync(IpcChannels.GET_WINDOW_FULLSCREEN_STATE_CHANNEL) === true,
  onWindowFullscreenStateChange: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, fullscreen: unknown) => {
      if (typeof fullscreen !== "boolean") return;
      listener(fullscreen);
    };

    ipcRenderer.on(IpcChannels.WINDOW_FULLSCREEN_STATE_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.WINDOW_FULLSCREEN_STATE_CHANNEL, wrappedListener);
    };
  },
  getUpdateState: () => invoke(IpcChannels.UPDATE_GET_STATE_CHANNEL),
  setUpdateChannel: (channel) => invoke(IpcChannels.UPDATE_SET_CHANNEL_CHANNEL, channel),
  checkForUpdate: () => invoke(IpcChannels.UPDATE_CHECK_CHANNEL),
  downloadUpdate: () => invoke(IpcChannels.UPDATE_DOWNLOAD_CHANNEL),
  installUpdate: () => invoke(IpcChannels.UPDATE_INSTALL_CHANNEL),
  onUpdateState: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
      if (typeof state !== "object" || state === null) return;
      listener(state as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(IpcChannels.UPDATE_STATE_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.UPDATE_STATE_CHANNEL, wrappedListener);
    };
  },
  energyDiagnostics: {
    captureProcessSnapshot: () => invoke(IpcChannels.ENERGY_CAPTURE_PROCESS_SNAPSHOT_CHANNEL),
    readIpcMessagePressureSnapshot,
    writeCaptureArtifact: (input) =>
      invoke(IpcChannels.ENERGY_WRITE_CAPTURE_ARTIFACT_CHANNEL, input),
    revealCaptureArtifact: (path) =>
      invoke(IpcChannels.ENERGY_REVEAL_CAPTURE_ARTIFACT_CHANNEL, path),
  },
  preview: {
    createTab: (tabId, defaults) =>
      invoke(IpcChannels.PREVIEW_CREATE_TAB_CHANNEL, {
        tabId,
        zoomFactor: defaults?.zoomFactor,
        colorScheme: defaults?.colorScheme,
      }),
    closeTab: (tabId) => invoke(IpcChannels.PREVIEW_CLOSE_TAB_CHANNEL, { tabId }),
    registerWebview: (tabId, webContentsId) =>
      invoke(IpcChannels.PREVIEW_REGISTER_WEBVIEW_CHANNEL, { tabId, webContentsId }),
    navigate: (tabId, url) => invoke(IpcChannels.PREVIEW_NAVIGATE_CHANNEL, { tabId, url }),
    goBack: (tabId) => invoke(IpcChannels.PREVIEW_GO_BACK_CHANNEL, { tabId }),
    goForward: (tabId) => invoke(IpcChannels.PREVIEW_GO_FORWARD_CHANNEL, { tabId }),
    refresh: (tabId) => invoke(IpcChannels.PREVIEW_REFRESH_CHANNEL, { tabId }),
    zoomIn: (tabId) => invoke(IpcChannels.PREVIEW_ZOOM_IN_CHANNEL, { tabId }),
    zoomOut: (tabId) => invoke(IpcChannels.PREVIEW_ZOOM_OUT_CHANNEL, { tabId }),
    resetZoom: (tabId) => invoke(IpcChannels.PREVIEW_RESET_ZOOM_CHANNEL, { tabId }),
    hardReload: (tabId) => invoke(IpcChannels.PREVIEW_HARD_RELOAD_CHANNEL, { tabId }),
    setColorScheme: (tabId, colorScheme) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_SET_COLOR_SCHEME_CHANNEL, { tabId, colorScheme }),
    openDevTools: (tabId) => invoke(IpcChannels.PREVIEW_OPEN_DEVTOOLS_CHANNEL, { tabId }),
    clearCookies: () => invoke(IpcChannels.PREVIEW_CLEAR_COOKIES_CHANNEL),
    clearCache: () => invoke(IpcChannels.PREVIEW_CLEAR_CACHE_CHANNEL),
    setAudioMuted: (tabId, audioMuted) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_SET_AUDIO_MUTED_CHANNEL, { tabId, audioMuted }),
    getPreviewConfig: (environmentId) =>
      invoke(IpcChannels.PREVIEW_GET_CONFIG_CHANNEL, { environmentId }),
    setAnnotationTheme: (theme) =>
      invoke(IpcChannels.PREVIEW_SET_ANNOTATION_THEME_CHANNEL, { theme }),
    pickElement: (tabId) => invoke(IpcChannels.PREVIEW_PICK_ELEMENT_CHANNEL, { tabId }),
    cancelPickElement: (tabId) =>
      invoke(IpcChannels.PREVIEW_CANCEL_PICK_ELEMENT_CHANNEL, { tabId }),
    captureScreenshot: (tabId) => invoke(IpcChannels.PREVIEW_CAPTURE_SCREENSHOT_CHANNEL, { tabId }),
    revealArtifact: (path) => invoke(IpcChannels.PREVIEW_REVEAL_ARTIFACT_CHANNEL, { path }),
    copyArtifactToClipboard: (path) => invoke(IpcChannels.PREVIEW_COPY_ARTIFACT_CHANNEL, { path }),
    pictureInPicture: {
      open: (tabId) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_PICTURE_IN_PICTURE_OPEN_CHANNEL, { tabId }),
      close: (tabId) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_PICTURE_IN_PICTURE_CLOSE_CHANNEL, { tabId }),
    },
    recording: {
      startScreencast: (tabId) => invoke(IpcChannels.PREVIEW_RECORDING_START_CHANNEL, { tabId }),
      stopScreencast: (tabId) => invoke(IpcChannels.PREVIEW_RECORDING_STOP_CHANNEL, { tabId }),
      save: (tabId, mimeType, data) =>
        invoke(IpcChannels.PREVIEW_RECORDING_SAVE_CHANNEL, {
          tabId,
          mimeType,
          data,
        }),
      onFrame: (listener) => {
        const wrappedListener = (_event: Electron.IpcRendererEvent, frame: unknown) => {
          if (typeof frame !== "object" || frame === null) return;
          listener(frame as DesktopPreviewRecordingFrame);
        };
        ipcRenderer.on(IpcChannels.PREVIEW_RECORDING_FRAME_CHANNEL, wrappedListener);
        return () =>
          ipcRenderer.removeListener(IpcChannels.PREVIEW_RECORDING_FRAME_CHANNEL, wrappedListener);
      },
    },
    automation: {
      status: (tabId) => invoke(IpcChannels.PREVIEW_AUTOMATION_STATUS_CHANNEL, { tabId }),
      snapshot: (tabId) => invoke(IpcChannels.PREVIEW_AUTOMATION_SNAPSHOT_CHANNEL, { tabId }),
      click: (tabId, input) =>
        invoke(IpcChannels.PREVIEW_AUTOMATION_CLICK_CHANNEL, { tabId, input }),
      type: (tabId, input) => invoke(IpcChannels.PREVIEW_AUTOMATION_TYPE_CHANNEL, { tabId, input }),
      press: (tabId, input) =>
        invoke(IpcChannels.PREVIEW_AUTOMATION_PRESS_CHANNEL, { tabId, input }),
      scroll: (tabId, input) =>
        invoke(IpcChannels.PREVIEW_AUTOMATION_SCROLL_CHANNEL, { tabId, input }),
      evaluate: (tabId, input) =>
        invoke(IpcChannels.PREVIEW_AUTOMATION_EVALUATE_CHANNEL, { tabId, input }),
      waitFor: (tabId, input) =>
        invoke(IpcChannels.PREVIEW_AUTOMATION_WAIT_FOR_CHANNEL, { tabId, input }),
    },
    onStateChange: (listener) => {
      const wrappedListener = (
        _event: Electron.IpcRendererEvent,
        tabId: unknown,
        state: unknown,
      ) => {
        if (typeof tabId !== "string" || typeof state !== "object" || state === null) return;
        listener(tabId, state as DesktopPreviewTabState);
      };
      ipcRenderer.on(IpcChannels.PREVIEW_STATE_CHANGE_CHANNEL, wrappedListener);
      return () =>
        ipcRenderer.removeListener(IpcChannels.PREVIEW_STATE_CHANGE_CHANNEL, wrappedListener);
    },
    onPointerEvent: (listener) => {
      const wrappedListener = (_event: Electron.IpcRendererEvent, pointerEvent: unknown) => {
        if (typeof pointerEvent !== "object" || pointerEvent === null) return;
        listener(pointerEvent as DesktopPreviewPointerEvent);
      };
      ipcRenderer.on(IpcChannels.PREVIEW_POINTER_EVENT_CHANNEL, wrappedListener);
      return () =>
        ipcRenderer.removeListener(IpcChannels.PREVIEW_POINTER_EVENT_CHANNEL, wrappedListener);
    },
  },
} satisfies DesktopBridge);
