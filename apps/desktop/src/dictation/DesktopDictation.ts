// @effect-diagnostics globalTimers:off -- The hold timer runs at the key helper's callback boundary outside Effect fibers.

import {
  DEFAULT_CLIENT_SETTINGS,
  type ClientSettings,
  type DesktopDictationDeliverRequest,
  type DesktopDictationDelivery,
  type DesktopDictationEvent,
  type DesktopDictationPill,
  type DesktopDictationPrepareRequest,
  type DesktopDictationStatus,
  type DesktopDictationTarget,
  type DictationKey,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Electron from "electron";

import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { MAC_PERMISSION_SETTINGS_URLS } from "../permissions/MacPermission.ts";
import * as MacPermissions from "../permissions/MacPermissions.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import { createDictationPill } from "./DictationPill.ts";
import {
  DICTATION_HOLD_MS,
  IDLE_DICTATION_PRESS,
  stepDictationPress,
  type DictationKeyInput,
} from "./dictationPress.ts";
import { startMacDictationKeyProcess, type DictationKeyLine } from "./MacDictationKeyProcess.ts";
import {
  dictationDraftFromField,
  pasteMacDictation,
  readMacDictationField,
  readMacGlobeKeyAction,
} from "./MacDictationTarget.ts";

const REMEMBERED_PRESSES = 8;

class DesktopDictationKeyError extends Schema.TaggedError<DesktopDictationKeyError>()(
  "DesktopDictationKeyError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not watch the dictation key.";
  }
}
const NO_WINDOW_MESSAGE = "Open T3 Code's window to dictate in other apps.";

type Press = {
  readonly id: number;
  readonly target: "t3" | "app";
  readonly frontPid: number;
  readonly forward: boolean;
};

export class DesktopDictation extends Context.Service<
  DesktopDictation,
  {
    readonly initialize: Effect.Effect<void>;
    readonly configure: (settings: ClientSettings) => Effect.Effect<void>;
    readonly status: Effect.Effect<DesktopDictationStatus>;
    readonly prepare: (
      request: DesktopDictationPrepareRequest,
    ) => Effect.Effect<DesktopDictationTarget>;
    readonly deliver: (
      request: DesktopDictationDeliverRequest,
    ) => Effect.Effect<DesktopDictationDelivery>;
    readonly setPill: (pill: DesktopDictationPill | null) => Effect.Effect<void>;
    readonly requestAccessibility: Effect.Effect<void>;
  }
>()("@t3tools/desktop/dictation/DesktopDictation") {}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const permissions = yield* MacPermissions.MacPermissions;
  const path = yield* Path.Path;
  const context = yield* Effect.context<DesktopWindow.DesktopWindow>();
  const runPromise = Effect.runPromiseWith(context);
  const supported = environment.platform === "darwin";

  let settings = DEFAULT_CLIENT_SETTINGS;
  let trigger: DictationKey = "off";
  let stopWatcher: (() => void) | null = null;
  let listening = false;
  let message: string | null = null;
  let press = IDLE_DICTATION_PRESS;
  let current: Press | null = null;
  let nextPressId = 0;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  const presses = new Map<number, Press>();

  const dispatch = (event: DesktopDictationEvent) =>
    runPromise(desktopWindow.dispatchDictationEvent(event)).catch(() => false);

  const pill = supported
    ? createDictationPill(path.join(environment.dirname, "dictation-pill-preload.cjs"), () => {
        pill?.hide();
        void runPromise(desktopWindow.revealOrCreateMain)
          .then(() => dispatch({ type: "pill-click" }))
          .catch(() => undefined);
      })
    : null;

  const step = (input: DictationKeyInput) => {
    const result = stepDictationPress(press, input);
    press = result.state;
    if (press.phase === "idle") clearTimeout(holdTimer);
    const output = result.output;
    const active = current;
    if (!output || !active?.forward) return;
    switch (output.type) {
      case "tap":
      case "hold":
        void dispatch({
          type: output.type,
          pressId: active.id,
          gesture: output.gesture,
          target: active.target,
        }).then((delivered) => {
          if (!delivered && active.target === "app")
            pill?.show({
              kind: "notice",
              tone: "error",
              message: NO_WINDOW_MESSAGE,
              clickable: false,
            });
        });
        return;
      case "gesture":
        void dispatch({ type: "gesture", pressId: active.id, gesture: output.gesture });
        return;
      case "release":
      case "cancel":
        void dispatch({ type: output.type, pressId: active.id });
        return;
    }
  };

  const onLine = (line: DictationKeyLine) => {
    switch (line.type) {
      case "escape":
        void dispatch({ type: "escape" });
        return;
      case "down": {
        const target = Electron.BrowserWindow.getFocusedWindow() === null ? "app" : "t3";
        const id = ++nextPressId;
        current = {
          id,
          target,
          frontPid: line.frontPid,
          forward: target === "t3" || settings.dictationInOtherApps,
        };
        presses.set(id, current);
        presses.delete(id - REMEMBERED_PRESSES);
        clearTimeout(holdTimer);
        holdTimer = setTimeout(() => step({ type: "held" }), DICTATION_HOLD_MS);
        step({ type: "down", modifiers: line.modifiers });
        return;
      }
      case "modifiers":
        step({ type: "modifiers", modifiers: line.modifiers });
        return;
      case "key":
      case "up":
        step({ type: line.type });
        return;
    }
  };

  const stop = () => {
    stopWatcher?.();
    stopWatcher = null;
    listening = false;
    clearTimeout(holdTimer);
    press = IDLE_DICTATION_PRESS;
  };

  const configure = Effect.fn("desktop.dictation.configure")(function* (next: ClientSettings) {
    settings = next;
    const desired = supported ? next.dictationKey : "off";
    if (desired === trigger && (listening || desired === "off")) return;
    stop();
    trigger = desired;
    message = null;
    if (desired === "off") return;
    const started = yield* Effect.tryPromise({
      try: () =>
        startMacDictationKeyProcess(desired, onLine, () => {
          if (trigger !== desired) return;
          stopWatcher = null;
          listening = false;
          message = "The dictation key stopped responding. Choose the key again to restart it.";
        }),
      catch: (cause) => new DesktopDictationKeyError({ cause }),
    }).pipe(Effect.option);
    if (trigger !== desired) {
      if (Option.isSome(started)) started.value();
      return;
    }
    if (Option.isNone(started)) {
      message = "Could not watch the dictation key.";
      return;
    }
    stopWatcher = started.value;
    listening = true;
  });

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      stop();
      pill?.dispose();
    }),
  );

  const appPress = (pressId: number) => {
    const found = presses.get(pressId);
    return found?.target === "app" ? found : null;
  };

  return DesktopDictation.of({
    initialize: clientSettings.get.pipe(
      Effect.flatMap((stored) =>
        configure(Option.getOrElse(stored, () => DEFAULT_CLIENT_SETTINGS)),
      ),
      Effect.ignore,
    ),
    configure,
    status: Effect.promise(async () => ({
      supported,
      listening,
      accessibility: supported && Electron.systemPreferences.isTrustedAccessibilityClient(false),
      globeKey: supported && trigger === "fn" ? await readMacGlobeKeyAction() : null,
      message,
    })).pipe(Effect.withSpan("desktop.dictation.status")),
    prepare: Effect.fn("desktop.dictation.prepare")(function* (request) {
      const found = appPress(request.pressId);
      if (!found) return { app: null, draft: null };
      const field = yield* Effect.promise(() =>
        readMacDictationField(found.frontPid, {
          field: settings.dictationReadsField,
          selection: request.selection,
        }),
      );
      if (!field) return { app: null, draft: null };
      if (field.front !== found.frontPid) return { app: field.app, draft: null };
      return { app: field.app, draft: dictationDraftFromField(field) };
    }),
    deliver: Effect.fn("desktop.dictation.deliver")(function* (request) {
      const found = appPress(request.pressId);
      const result = found
        ? yield* Effect.promise(() => pasteMacDictation(found.frontPid, request.text))
        : "failed";
      if (result !== "failed") return result;
      // The text must survive a helper that could not run.
      Electron.clipboard.writeText(request.text);
      return "copied" as const;
    }),
    requestAccessibility: Effect.gen(function* () {
      if (!supported || Electron.systemPreferences.isTrustedAccessibilityClient(false)) return;
      const owner = Electron.BrowserWindow.getFocusedWindow();
      yield* Effect.promise(() =>
        Electron.shell
          .openExternal(MAC_PERMISSION_SETTINGS_URLS.accessibility)
          .catch(() => undefined),
      );
      yield* permissions.showHelper("accessibility", owner);
    }).pipe(Effect.withSpan("desktop.dictation.requestAccessibility")),
    setPill: Effect.fn("desktop.dictation.setPill")(function (next) {
      return Effect.sync(() => {
        if (next) pill?.show(next);
        else pill?.hide();
      });
    }),
  });
});

export const layer = Layer.effect(DesktopDictation, make);
