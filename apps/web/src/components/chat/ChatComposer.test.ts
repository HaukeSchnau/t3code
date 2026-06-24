import { describe, expect, it } from "vite-plus/test";

import { shouldDisableComposerPromptEditor } from "./ChatComposer";

describe("shouldDisableComposerPromptEditor", () => {
  it("keeps the prompt editable while the environment is disconnected", () => {
    expect(
      shouldDisableComposerPromptEditor({
        isConnecting: false,
        isComposerApprovalState: false,
        isEnvironmentUnavailable: true,
      }),
    ).toBe(false);
  });

  it("disables the prompt while connecting", () => {
    expect(
      shouldDisableComposerPromptEditor({
        isConnecting: true,
        isComposerApprovalState: false,
        isEnvironmentUnavailable: false,
      }),
    ).toBe(true);
  });

  it("disables the prompt for approval-only composer states", () => {
    expect(
      shouldDisableComposerPromptEditor({
        isConnecting: false,
        isComposerApprovalState: true,
        isEnvironmentUnavailable: false,
      }),
    ).toBe(true);
  });
});
