import { describe, expect, it } from "vitest";

import {
  captureTerminalViewportSnapshot,
  renderTerminalOutput,
  resolveTerminalViewportScrollTop,
} from "./terminalOutput";

describe("renderTerminalOutput", () => {
  it("keeps only the latest carriage-return rewrite for a line", () => {
    expect(renderTerminalOutput("Downloading 10%\rDownloading 100%\nDone\n")).toBe(
      "Downloading 100%\nDone",
    );
  });

  it("handles erase-line and backspace control sequences", () => {
    expect(renderTerminalOutput("count: 100%\b\b\b25%\u001b[K\n")).toBe("count: 125%");
  });

  it("resets the transcript when the terminal sends a full clear", () => {
    expect(renderTerminalOutput("old output\n\u001bcnew output\n")).toBe("new output");
  });
});

describe("terminal viewport helpers", () => {
  it("keeps the viewport pinned to the bottom when it was already there", () => {
    const previous = captureTerminalViewportSnapshot({
      scrollTop: 140,
      scrollHeight: 240,
      clientHeight: 100,
    });

    expect(
      resolveTerminalViewportScrollTop({
        previous,
        nextScrollHeight: 320,
        clientHeight: 100,
      }),
    ).toBe(220);
  });

  it("preserves manual scroll position when the user is reading older output", () => {
    const previous = captureTerminalViewportSnapshot({
      scrollTop: 32,
      scrollHeight: 240,
      clientHeight: 100,
    });

    expect(
      resolveTerminalViewportScrollTop({
        previous,
        nextScrollHeight: 320,
        clientHeight: 100,
      }),
    ).toBe(32);
  });
});
