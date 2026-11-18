import { describe, expect, it } from "vite-plus/test";

import {
  IDLE_DICTATION_PRESS,
  stepDictationPress,
  type DictationKeyInput,
} from "./dictationPress.ts";

const none = { shift: false, control: false };

function run(inputs: readonly DictationKeyInput[]) {
  let state = IDLE_DICTATION_PRESS;
  const outputs = [];
  for (const input of inputs) {
    const step = stepDictationPress(state, input);
    state = step.state;
    if (step.output) outputs.push(step.output);
  }
  return { state, outputs };
}

describe("stepDictationPress", () => {
  it.each([
    {
      name: "a quick press is a tap",
      inputs: [{ type: "down", modifiers: none }, { type: "up" }],
      outputs: [{ type: "tap", gesture: "dictate" }],
    },
    {
      name: "a long press holds and releases",
      inputs: [{ type: "down", modifiers: none }, { type: "held" }, { type: "up" }],
      outputs: [{ type: "hold", gesture: "dictate" }, { type: "release" }],
    },
    {
      name: "a key during the press before the hold starts nothing",
      inputs: [
        { type: "down", modifiers: none },
        { type: "key" },
        { type: "held" },
        { type: "up" },
      ],
      outputs: [],
    },
    {
      name: "a key after the hold cancels the recording it started",
      inputs: [
        { type: "down", modifiers: none },
        { type: "held" },
        { type: "key" },
        { type: "key" },
        { type: "up" },
      ],
      outputs: [{ type: "hold", gesture: "dictate" }, { type: "cancel" }],
    },
    {
      name: "Shift held from the start makes a draft",
      inputs: [
        { type: "down", modifiers: { shift: true, control: false } },
        { type: "modifiers", modifiers: none },
        { type: "up" },
      ],
      outputs: [{ type: "tap", gesture: "draft" }],
    },
    {
      name: "a modifier added during the hold changes the gesture",
      inputs: [
        { type: "down", modifiers: none },
        { type: "held" },
        { type: "modifiers", modifiers: { shift: true, control: false } },
        { type: "modifiers", modifiers: { shift: true, control: true } },
        { type: "modifiers", modifiers: none },
        { type: "up" },
      ],
      outputs: [
        { type: "hold", gesture: "dictate" },
        { type: "gesture", gesture: "draft" },
        { type: "gesture", gesture: "command" },
        { type: "release" },
      ],
    },
    {
      name: "Control wins over Shift",
      inputs: [
        { type: "down", modifiers: { shift: true, control: true } },
        { type: "held" },
        { type: "up" },
      ],
      outputs: [{ type: "hold", gesture: "command" }, { type: "release" }],
    },
  ] satisfies ReadonlyArray<{
    name: string;
    inputs: readonly DictationKeyInput[];
    outputs: readonly unknown[];
  }>)("$name", ({ inputs, outputs }) => {
    const result = run(inputs);
    expect(result.outputs).toEqual(outputs);
    expect(result.state).toEqual(IDLE_DICTATION_PRESS);
  });
});
