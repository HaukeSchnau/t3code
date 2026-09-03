/**
 * One live docs frame for the fixture's Preview lens, with the real preview
 * chrome row. Link clicks inside the page post their path back so the frame
 * navigates like a browser without any server.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { PreviewChromeRow } from "../preview/PreviewChromeRow";
import type { FixturePreviewVariant } from "./model";
import { isPreviewNavMessage, normalizePreviewPath, renderDocsPage } from "./previewPages";

function previewOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

export function PreviewFrame({
  variant,
  url,
  title,
  className,
}: {
  readonly variant: FixturePreviewVariant;
  readonly url: string;
  readonly title: string;
  readonly className?: string;
}) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [path, setPath] = useState("/docs/");
  const [history, setHistory] = useState<ReadonlyArray<string>>([]);
  const srcDoc = useMemo(() => renderDocsPage(variant, path), [variant, path]);
  const origin = previewOrigin(url);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (frameRef.current === null || event.source !== frameRef.current.contentWindow) return;
      if (!isPreviewNavMessage(event.data)) return;
      const next = normalizePreviewPath(event.data.path);
      setHistory((current) => [...current, path]);
      setPath(next);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [path]);

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <PreviewChromeRow
        url={`${origin}${path}`}
        loading={false}
        canGoBack={history.length > 0}
        canGoForward={false}
        refreshDisabled={false}
        onBack={() => {
          const previous = history.at(-1);
          if (previous === undefined) return;
          setHistory((current) => current.slice(0, -1));
          setPath(previous);
        }}
        onForward={() => undefined}
        onRefresh={() => setPath((current) => current)}
        onSubmit={(value) => {
          const next = value.startsWith("http") ? value.slice(previewOrigin(value).length) : value;
          setHistory((current) => [...current, path]);
          setPath(normalizePreviewPath(next));
        }}
      />
      <iframe
        ref={frameRef}
        title={title}
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        className="min-h-0 w-full flex-1 border-0 bg-white"
      />
    </div>
  );
}
