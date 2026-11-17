import type { DesktopDictationEvent, VoiceShortcutMode } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createFnPressRunner,
  reduceFnDictation,
  type FnDictationAction,
  type FnDictationPress,
} from "./fnDictation";

function run(
  mode: VoiceShortcutMode,
  steps: ReadonlyArray<{ event: DesktopDictationEvent; busy?: "composer" | "headless" }>,
) {
  let active: FnDictationPress | null = null;
  const actions: Array<FnDictationAction["type"] | `${FnDictationAction["type"]}:${string}`> = [];
  for (const { event, busy = null } of steps) {
    const result = reduceFnDictation(active, event, { mode, busy });
    active = result.active;
    if (!result.action) continue;
    actions.push(
      result.action.type === "start"
        ? `start:${result.action.press.route}`
        : `${result.action.type}:${result.action.route}`,
    );
  }
  return actions;
}

const tap = (pressId: number, target: "t3" | "app" = "t3") =>
  ({ type: "tap", pressId, gesture: "dictate", target }) as const;
const hold = (pressId: number, gesture: "dictate" | "draft" | "command" = "dictate") =>
  ({ type: "hold", pressId, gesture, target: "t3" }) as const;
const release = (pressId: number) => ({ type: "release", pressId }) as const;

describe("reduceFnDictation", () => {
  it("toggles on taps and talks while held in auto mode", () => {
    expect(
      run("auto", [
        { event: tap(1) },
        { event: tap(2), busy: "composer" },
        { event: hold(3) },
        { event: release(3), busy: "composer" },
      ]),
    ).toEqual(["start:composer", "stop:composer", "start:composer", "stop:composer"]);
  });

  it("ignores taps in hold mode and releases in toggle mode", () => {
    expect(run("hold", [{ event: tap(1) }])).toEqual([]);
    expect(
      run("toggle", [
        { event: hold(1) },
        { event: release(1), busy: "composer" },
        { event: tap(2), busy: "composer" },
      ]),
    ).toEqual(["start:composer", "stop:composer"]);
  });

  it("does not stop a recording on the release of the press that stopped another", () => {
    expect(
      run("auto", [{ event: tap(1) }, { event: hold(2), busy: "composer" }, { event: release(2) }]),
    ).toEqual(["start:composer", "stop:composer"]);
  });

  it("routes other apps and drafts to the headless recorder", () => {
    expect(run("auto", [{ event: tap(1, "app") }])).toEqual(["start:headless"]);
    expect(run("auto", [{ event: hold(1, "draft") }])).toEqual(["start:headless"]);
  });

  it("cancels only the press that started, and Escape cancels whatever runs", () => {
    expect(
      run("auto", [
        { event: hold(1) },
        { event: { type: "cancel", pressId: 9 } },
        { event: { type: "cancel", pressId: 1 } },
        { event: { type: "escape" }, busy: "headless" },
        { event: { type: "escape" } },
      ]),
    ).toEqual(["start:composer", "cancel:composer", "cancel:headless"]);
  });

  it("lets a held composer recording become a command but not a draft", () => {
    expect(
      run("auto", [
        { event: hold(1) },
        { event: { type: "gesture", pressId: 1, gesture: "draft" } },
        { event: { type: "gesture", pressId: 1, gesture: "command" } },
      ]),
    ).toEqual(["start:composer", "retarget:composer"]);
  });
});

function preparingSpeech() {
  const calls: string[] = [];
  let beginRecording = () => {};
  const speech = {
    start: () => {
      calls.push("start");
      return new Promise<void>((resolve) => {
        beginRecording = resolve;
      });
    },
    stop: async () => {
      calls.push("stop");
    },
    cancel: () => {
      calls.push("cancel");
    },
  };
  return { speech, calls, beginRecording: () => beginRecording() };
}

describe("createFnPressRunner", () => {
  it("stops a press released while preparing once it records", async () => {
    const runner = createFnPressRunner();
    const { speech, calls, beginRecording } = preparingSpeech();
    runner.start("headless", speech);
    const stopped = runner.stop("headless", null);
    expect(calls).toEqual(["start"]);
    beginRecording();
    await stopped;
    expect(calls).toEqual(["start", "stop"]);
  });

  it("drops that stop when the press is cancelled first", async () => {
    const runner = createFnPressRunner();
    const { speech, calls, beginRecording } = preparingSpeech();
    runner.start("composer", speech);
    const stopped = runner.stop("composer", null);
    runner.cancel("composer", null);
    beginRecording();
    await stopped;
    expect(calls).toEqual(["start", "cancel"]);
  });

  it("stops a recording another route started through the fallback", async () => {
    const runner = createFnPressRunner();
    const started = preparingSpeech();
    const other = preparingSpeech();
    runner.start("headless", started.speech);
    await runner.stop("composer", other.speech);
    expect(other.calls).toEqual(["stop"]);
    expect(started.calls).toEqual(["start"]);
  });
});
