import { useEffect, useState, type ReactNode } from "react";

import { renderMermaidDiagram } from "../lib/mermaid";

export function MermaidDiagram({
  code,
  theme,
  isStreaming,
  fallback,
}: {
  code: string;
  theme: "light" | "dark";
  isStreaming: boolean;
  fallback: ReactNode;
}) {
  const [result, setResult] = useState<{
    code: string;
    theme: "light" | "dark";
    image: string | null;
  } | null>(null);

  useEffect(() => {
    if (isStreaming) return;
    const controller = new AbortController();
    void renderMermaidDiagram(code, theme, controller.signal).then(
      (image) => {
        if (!controller.signal.aborted) setResult({ code, theme, image });
      },
      () => {
        if (!controller.signal.aborted) setResult({ code, theme, image: null });
      },
    );
    return () => controller.abort();
  }, [code, theme, isStreaming]);

  if (isStreaming) return fallback;
  const current = result?.code === code && result.theme === theme ? result : null;
  if (current?.image) {
    return (
      <div className="overflow-auto p-3">
        <img
          src={current.image}
          alt="Mermaid diagram"
          className="mx-auto max-h-[36rem] w-full object-contain"
          onError={() => setResult({ code, theme, image: null })}
        />
      </div>
    );
  }
  return (
    <>
      <p className="px-3 pt-2 text-xs text-muted-foreground" role="status">
        {current ? "Could not render this diagram. Showing source." : "Rendering diagram…"}
      </p>
      {fallback}
    </>
  );
}
