import { describe, expect, it } from "vite-plus/test";

import { buildThreadTitlePrompt, buildTurnEndAskPrompt } from "./textGenerationPrompts.ts";
import { normalizeCliError } from "./textGenerationUtils.ts";

describe("buildThreadTitlePrompt", () => {
  it("prefers stability during automatic title refreshes", () => {
    const result = buildThreadTitlePrompt({
      message: "USER:\nContinue implementing the reconnect fix",
      previousTitle: "Fix reconnect recovery",
      automaticRefresh: true,
    });

    expect(result.prompt).toContain(
      "Keep the previous title exactly when it remains accurate. Change it only for a meaningful specificity gain or a clear user-led topic shift.",
    );
    expect(result.prompt).not.toContain("Otherwise return a meaningfully improved title");
  });
});

describe("buildTurnEndAskPrompt", () => {
  it("keeps the end of a long final message without half an emoji", () => {
    // The cut falls between the two halves of the emoji.
    const ending = `${"a".repeat(2_990)} Ship it?`;
    const { prompt } = buildTurnEndAskPrompt({ finalMessage: `x\u{1F600}${ending}` });
    expect(prompt.endsWith(`[Earlier content truncated]\n\n${ending}`)).toBe(true);
  });
});

describe("normalizeCliError", () => {
  it("does not expose CLI failure details in the public error message", () => {
    const result = normalizeCliError(
      "codex",
      "generateCommitMessage",
      new Error("request failed with access_token=secret-token"),
      "Failed to generate a commit message",
    );

    expect(result.detail).toBe("Failed to generate a commit message");
    expect(result.message).not.toContain("secret-token");
  });
});
