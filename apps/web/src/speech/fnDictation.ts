import type {
  DesktopDictationEvent,
  DesktopDictationGesture,
  VoiceShortcutMode,
} from "@t3tools/contracts";

/** `composer` dictates into a T3 editor; `headless` records for another app or a new draft. */
export type FnDictationRoute = "composer" | "headless";

export type FnDictationPress = {
  readonly pressId: number;
  readonly route: FnDictationRoute;
  readonly gesture: DesktopDictationGesture;
  readonly target: "t3" | "app";
  readonly stopsOnRelease: boolean;
};

export type FnDictationAction =
  | { readonly type: "start"; readonly press: FnDictationPress }
  | { readonly type: "stop" | "cancel"; readonly route: FnDictationRoute }
  | {
      readonly type: "retarget";
      readonly route: FnDictationRoute;
      readonly gesture: DesktopDictationGesture;
    };

function routeFor(gesture: DesktopDictationGesture, target: "t3" | "app"): FnDictationRoute {
  return gesture === "draft" || target === "app" ? "headless" : "composer";
}

/**
 * Applies a dictation key event. Any press while a recording runs stops it; a hold started
 * recording stops on release unless the mode is toggle, and a tap starts nothing in hold mode.
 */
export function reduceFnDictation(
  active: FnDictationPress | null,
  event: DesktopDictationEvent,
  context: { readonly mode: VoiceShortcutMode; readonly busy: FnDictationRoute | null },
): { readonly active: FnDictationPress | null; readonly action: FnDictationAction | null } {
  switch (event.type) {
    case "tap":
    case "hold": {
      if (context.busy) return { active: null, action: { type: "stop", route: context.busy } };
      if (event.type === "tap" && context.mode === "hold") return { active: null, action: null };
      const press: FnDictationPress = {
        pressId: event.pressId,
        route: routeFor(event.gesture, event.target),
        gesture: event.gesture,
        target: event.target,
        stopsOnRelease: event.type === "hold" && context.mode !== "toggle",
      };
      return { active: press, action: { type: "start", press } };
    }
    case "release":
      if (active?.pressId !== event.pressId || !active.stopsOnRelease)
        return { active, action: null };
      return { active: null, action: { type: "stop", route: active.route } };
    case "cancel":
      if (active?.pressId !== event.pressId) return { active, action: null };
      return { active: null, action: { type: "cancel", route: active.route } };
    case "gesture":
      // A composer recording cannot become a new draft; it can become a command.
      if (
        active?.pressId !== event.pressId ||
        (active.route === "composer" && event.gesture === "draft")
      )
        return { active, action: null };
      return {
        active: { ...active, gesture: event.gesture },
        action: { type: "retarget", route: active.route, gesture: event.gesture },
      };
    case "escape":
      if (!context.busy) return { active, action: null };
      return { active: null, action: { type: "cancel", route: context.busy } };
    case "pill-click":
      return { active, action: null };
  }
}
