import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { renderMermaidDiagram } from "../lib/mermaid";
import { MermaidDiagram } from "./MermaidDiagram";

vi.mock("../lib/mermaid", () => ({ renderMermaidDiagram: vi.fn() }));

const renderDiagram = vi.mocked(renderMermaidDiagram);
const code = "flowchart LR\nA[Agent] --> B[Diagram]";
let renderer: ReactTestRenderer;

function deferred() {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function diagram(source = code, theme: "light" | "dark" = "light", isStreaming = false) {
  return (
    <MermaidDiagram
      code={source}
      theme={theme}
      isStreaming={isStreaming}
      fallback={<pre>{source}</pre>}
    />
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  renderDiagram.mockReset();
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});

describe("MermaidDiagram", () => {
  it("keeps streaming source readable and renders only when streaming ends", async () => {
    renderDiagram.mockResolvedValue("data:image/svg+xml,diagram");
    await act(async () => {
      renderer = create(diagram("flowchart LR", "light", true));
    });
    await act(async () => renderer.update(diagram(code, "light", true)));
    expect(renderDiagram).not.toHaveBeenCalled();
    expect(renderer.root.findByType("pre").children).toEqual([code]);

    await act(async () => renderer.update(diagram()));
    expect(renderer.root.findByType("img").props.src).toBe("data:image/svg+xml,diagram");
    await act(async () => renderer.update(diagram()));
    expect(renderDiagram).toHaveBeenCalledTimes(1);
  });

  it("retains source on failure and recovers when corrected", async () => {
    renderDiagram.mockRejectedValueOnce(new Error("Invalid syntax"));
    await act(async () => {
      renderer = create(diagram("invalid"));
    });
    expect(renderer.root.findByType("pre").children).toEqual(["invalid"]);
    expect(renderer.root.findByProps({ role: "status" }).children.join("")).toContain(
      "Could not render",
    );

    renderDiagram.mockResolvedValueOnce("data:image/svg+xml,corrected");
    await act(async () => renderer.update(diagram()));
    expect(renderer.root.findByType("img").props.src).toBe("data:image/svg+xml,corrected");
  });

  it("ignores obsolete renders when source or theme changes", async () => {
    const first = deferred();
    const second = deferred();
    renderDiagram.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await act(async () => {
      renderer = create(diagram());
    });
    const firstSignal = renderDiagram.mock.calls[0]![2];
    await act(async () => renderer.update(diagram("flowchart LR\nB --> C", "dark")));
    expect(firstSignal.aborted).toBe(true);
    await act(async () => second.resolve("data:image/svg+xml,current"));
    await act(async () => first.resolve("data:image/svg+xml,obsolete"));
    expect(renderer.root.findByType("img").props.src).toBe("data:image/svg+xml,current");
  });
});
