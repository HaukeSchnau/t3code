let renderQueue = Promise.resolve();
let nextDiagramId = 0;

// Mermaid has global configuration. Serialize initialization and rendering together
// so a theme change cannot affect a diagram already being rendered.
export function renderMermaidDiagram(
  source: string,
  theme: "light" | "dark",
  signal: AbortSignal,
): Promise<string> {
  const result = renderQueue.then(async () => {
    signal.throwIfAborted();
    if (source.length > 50_000) {
      throw new Error("Diagram exceeds the rendering limit.");
    }
    const { default: mermaid } = await import("mermaid");
    signal.throwIfAborted();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: theme === "dark" ? "dark" : "default",
      // SVG images cannot display HTML labels consistently across browsers.
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      secure: [
        "secure",
        "securityLevel",
        "startOnLoad",
        "suppressErrorRendering",
        "maxTextSize",
        "maxEdges",
        "htmlLabels",
        "flowchart",
      ],
    });
    const container = document.createElement("div");
    container.style.cssText = "position:fixed;left:-100000px;top:0;visibility:hidden";
    container.setAttribute("aria-hidden", "true");
    document.body.append(container);
    try {
      const { svg } = await mermaid.render(`t3-mermaid-${nextDiagramId++}`, source, container);
      signal.throwIfAborted();
      // An image isolates diagram styles and disables embedded scripts and links.
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    } finally {
      container.remove();
    }
  });
  renderQueue = result.then(
    () => {},
    () => {},
  );
  return result;
}
