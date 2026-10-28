import {
  GUEST_RENDER_ROUTE,
  GUEST_RENDER_STATE_ROUTE,
  GUEST_SHARE_PARAM,
  HtmlRenderState as HtmlRenderStateSchema,
  type HtmlRenderState,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  type HtmlRenderReference,
  HTML_RENDER_COLUMN_WIDTH,
  htmlRenderFrameHeight,
  htmlRenderResult,
  htmlRenderThemeFragment,
  htmlRenderThemeMessage,
  readHtmlRenderContentHeight,
  readHtmlRenderLinkRequest,
} from "@t3tools/shared/htmlRender";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useHtmlRenderHost } from "~/components/files/useHtmlRenderHost";
import { useHtmlRenderTheme } from "~/hooks/useHtmlRenderTheme";
import { observeResize } from "~/lib/observeResize";

const isHtmlRenderState = Schema.is(HtmlRenderStateSchema);

/**
 * A visual the agent published, as the guest sees it: its newest version, opened with the state
 * the owner's page saved. The server sends it with a sandbox CSP and the frame is sandboxed too,
 * so the page runs scripts in an opaque origin. It can size itself, copy, and ask to open a web
 * link; it cannot reach the guest's session, send, call tools, or save state.
 */
export function GuestHtmlRender({
  itemId,
  reference,
  shareId,
}: {
  readonly itemId: string;
  readonly reference: HtmlRenderReference;
  readonly shareId: string;
}) {
  const theme = useHtmlRenderTheme();
  const boxRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [width, setWidth] = useState(HTML_RENDER_COLUMN_WIDTH);
  const [contentHeight, setContentHeight] = useState<number>();
  // The theme and saved state ride in the fragment for the first paint; later theme changes are posted.
  const [src, setSrc] = useState<string | null>(null);
  const page = `${GUEST_RENDER_ROUTE}?${GUEST_SHARE_PARAM}=${encodeURIComponent(shareId)}&item=${encodeURIComponent(itemId)}`;
  const initialTheme = useRef(theme);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Reads the page's saved state from the server once before the frame loads.
  useEffect(() => {
    let current = true;
    const open = (state?: HtmlRenderState) => {
      if (current) setSrc(`${page}${htmlRenderThemeFragment(initialTheme.current, state)}`);
    };
    fetch(
      `${GUEST_RENDER_STATE_ROUTE}?${GUEST_SHARE_PARAM}=${encodeURIComponent(shareId)}&item=${encodeURIComponent(itemId)}`,
    )
      .then((response) => (response.ok ? response.json() : undefined))
      .then((state: unknown) => open(isHtmlRenderState(state) ? state : undefined))
      .catch(() => open());
    return () => {
      current = false;
    };
  }, [page, shareId, itemId]);
  useHtmlRenderHost(frameRef, undefined);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the frame box and follows its width with a ResizeObserver before paint
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    setWidth(box.clientWidth);
    return observeResize(box, ([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
  }, []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- posts theme changes to the iframe's window
  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage(htmlRenderThemeMessage(theme), "*");
  }, [theme]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window message listener for the iframe's height reports and link requests
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (frame === null || event.source !== frame.contentWindow) return;
      const height = readHtmlRenderContentHeight(event.data);
      if (height !== undefined) {
        setContentHeight(height);
        return;
      }
      // Only while the reader is using this frame, so a page cannot open links on its own.
      const link = readHtmlRenderLinkRequest(event.data);
      if (
        link === undefined ||
        document.activeElement !== frame ||
        navigator.userActivation?.isActive === false
      ) {
        return;
      }
      window.open(link.url, "_blank", "noopener,noreferrer");
      frame.contentWindow?.postMessage(htmlRenderResult(link.id), "*");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <div
      ref={boxRef}
      style={{
        height: htmlRenderFrameHeight(reference, width, contentHeight),
      }}
    >
      {src === null ? null : (
        <iframe
          ref={frameRef}
          src={src}
          title={reference.title}
          sandbox="allow-scripts allow-forms allow-popups allow-downloads"
          allow="clipboard-write; fullscreen"
          className="block size-full rounded-lg border border-border"
        />
      )}
    </div>
  );
}
