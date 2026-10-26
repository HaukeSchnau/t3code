import type {
  EnvironmentId,
  HtmlRenderState,
  OrchestrationMessageContext,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  HTML_RENDER_COLUMN_WIDTH,
  htmlRenderFileName,
  htmlRenderFrameHeight,
  type HtmlRenderReference,
  type HtmlRenderVersionEntry,
} from "@t3tools/shared/htmlRender";
import { ChevronLeftIcon, ChevronRightIcon, Maximize2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useAssetUrlRefresh } from "~/assets/assetUrls";
import { useLongLivedAssetUrl } from "~/assets/longLivedAssetUrls";
import { cn } from "~/lib/utils";
import { htmlRenderEnvironment } from "~/state/htmlRender";
import { useEnvironmentQuery } from "~/state/query";

import { HtmlRenderDocument } from "../files/BrowserDocumentFrame";
import type { HtmlRenderPageBridge } from "../files/useHtmlRenderHost";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { HtmlRenderDialog } from "./HtmlRenderDialog";
import { observeResize } from "~/lib/observeResize";

const MIN_URL_LIFE_MS = 5 * 60_000;
const NO_STATE: HtmlRenderState = {};

/**
 * One render and its versions. The reader follows the newest version until they page back;
 * then a newer one only marks itself. Saved state belongs to the render, so every version
 * opens with the latest.
 */
export function HtmlRenderFrame(props: {
  readonly environmentId: EnvironmentId;
  readonly htmlRender: HtmlRenderReference;
  readonly versions: ReadonlyArray<HtmlRenderVersionEntry>;
  readonly threadRef: ScopedThreadRef | undefined;
  readonly onFullscreenChange?: (fullscreen: boolean) => void;
  readonly onSendMessage?:
    | ((text: string, context: OrchestrationMessageContext) => Promise<void>)
    | undefined;
}) {
  const renderId = props.htmlRender.attachmentId;
  const last = props.versions.length - 1;
  const [selected, setSelected] = useState<number | null>(null);
  const index = selected === null ? last : Math.min(selected, last);
  const shown = props.versions[index]?.htmlRender ?? props.htmlRender;
  const select = (next: number) => setSelected(next >= last ? null : next);

  const savedState = useEnvironmentQuery(
    props.threadRef === undefined
      ? null
      : htmlRenderEnvironment.stateQuery({
          environmentId: props.environmentId,
          input: { threadId: props.threadRef.threadId, renderId },
        }),
  );
  // Versions opened later must see what earlier ones saved, not the state read at mount.
  const latestState = useRef<HtmlRenderState | null>(null);
  // An older server lacks the state RPC; its pages still open, without saved state.
  const stateReady =
    props.threadRef === undefined || savedState.isSuccess || savedState.error !== null;
  const readState = () => latestState.current ?? savedState.data ?? NO_STATE;
  const { onSendMessage } = props;
  const bridge: HtmlRenderPageBridge | undefined =
    props.threadRef === undefined
      ? undefined
      : {
          environmentId: props.environmentId,
          threadId: props.threadRef.threadId,
          renderId,
          title: shown.title,
          onSendMessage:
            onSendMessage === undefined
              ? undefined
              : (message) => onSendMessage(message.text, message.context),
          onStateSaved: (state) => {
            latestState.current = state;
          },
        };

  return (
    <div className="group/html-render relative">
      {stateReady ? (
        <HtmlRenderVersionFrame
          key={shown.attachmentId}
          environmentId={props.environmentId}
          htmlRender={shown}
          threadRef={props.threadRef}
          bridge={bridge}
          readState={readState}
          onFullscreenChange={props.onFullscreenChange}
        />
      ) : (
        <div style={{ height: htmlRenderFrameHeight(shown, HTML_RENDER_COLUMN_WIDTH) }} />
      )}
      {last > 0 ? (
        <div
          className={cn(
            "absolute end-10 top-2 flex items-center gap-1 transition-opacity duration-150 focus-within:opacity-100 group-hover/html-render:opacity-100 pointer-coarse:opacity-100",
            index < last ? "opacity-100" : "opacity-0",
          )}
        >
          <Button
            aria-label="Previous version"
            size="icon-xs"
            variant="glass"
            disabled={index === 0}
            onClick={() => select(index - 1)}
          >
            <ChevronLeftIcon className="size-3.5" />
          </Button>
          <span className="rounded-full surface-glass px-2 py-0.5 text-foreground text-xs tabular-nums">
            {index + 1} of {last + 1}
          </span>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label={index < last ? "Next version, a newer one exists" : "Next version"}
                  size="icon-xs"
                  variant="glass"
                  disabled={index === last}
                  onClick={() => select(index + 1)}
                />
              }
            >
              <ChevronRightIcon className="size-3.5" />
              {index < last ? (
                <span className="absolute -end-0.5 -top-0.5 size-2 rounded-full bg-primary" />
              ) : null}
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              {index < last ? "A newer version exists" : "Newest version"}
            </TooltipPopup>
          </Tooltip>
        </div>
      ) : null}
    </div>
  );
}

function HtmlRenderVersionFrame(props: {
  readonly environmentId: EnvironmentId;
  readonly htmlRender: HtmlRenderReference;
  readonly threadRef: ScopedThreadRef | undefined;
  readonly bridge: HtmlRenderPageBridge | undefined;
  readonly readState: () => HtmlRenderState;
  readonly onFullscreenChange?: ((fullscreen: boolean) => void) | undefined;
}) {
  const { attachmentId, title } = props.htmlRender;
  const [width, setWidth] = useState(HTML_RENDER_COLUMN_WIDTH);
  const observeBox = (box: HTMLDivElement) => {
    setWidth(box.clientWidth);
    return observeResize(box, ([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
  };
  // Client fonts can exceed the server-measured height and cause nested scrolling.
  const [contentHeight, setContentHeight] = useState<number>();
  const height = htmlRenderFrameHeight(props.htmlRender, width, contentHeight);
  const fileName = htmlRenderFileName(title);
  const resource = {
    _tag: "attachment" as const,
    attachmentId,
    fileName,
    mimeType: "text/html",
    disposition: "inline" as const,
  };
  // The frame keeps the first URL it loads, so later mints do not reload the page.
  const [loaded, setLoaded] = useState<{ src: string; expiresAt: number } | null>(null);
  const assetUrl = useLongLivedAssetUrl(loaded === null ? props.environmentId : null, resource);
  if (loaded === null && assetUrl._tag === "Success") {
    setLoaded({ src: assetUrl.url, expiresAt: assetUrl.expiresAt });
  }
  const src = loaded?.src ?? null;
  const failed = loaded === null && assetUrl._tag === "Failure";
  const refresh = useAssetUrlRefresh(props.environmentId, resource);
  const [expandedSrc, setExpandedSrc] = useState<string | null>(null);
  // The inline page reloads after full screen so it shows what was saved there.
  const [inlineLoad, setInlineLoad] = useState(0);
  const { onFullscreenChange } = props;
  // Tied to the viewer's lifetime: unmounting while expanded must still release
  // the timeline's follow pin, which a close handler alone never reaches.
  const expanded = expandedSrc !== null;
  useEffect(() => {
    if (!expanded) return;
    onFullscreenChange?.(true);
    return () => onFullscreenChange?.(false);
  }, [expanded, onFullscreenChange]);

  return (
    <div ref={observeBox} className="relative" style={{ height }}>
      {src !== null ? (
        <>
          <HtmlRenderDocument
            key={inlineLoad}
            src={src}
            title={title}
            threadRef={props.threadRef}
            className="block size-full"
            bridge={expanded ? undefined : props.bridge}
            state={props.readState()}
            onContentHeight={setContentHeight}
            onFullscreenChange={onFullscreenChange}
          />
          <div className="absolute end-2 top-2 flex gap-1 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/html-render:opacity-100 pointer-coarse:opacity-100">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label="Open full screen"
                    size="icon-xs"
                    variant="glass"
                    onClick={async () => {
                      const url =
                        loaded !== null && loaded.expiresAt - Date.now() > MIN_URL_LIFE_MS
                          ? src
                          : await refresh().catch(() => null);
                      if (url !== null) setExpandedSrc(url);
                      else
                        toastManager.add({
                          type: "error",
                          title: "Page unavailable",
                          description: "Reconnect to the environment and try again.",
                        });
                    }}
                  />
                }
              >
                <Maximize2Icon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="left">Open full screen</TooltipPopup>
            </Tooltip>
          </div>
          {expandedSrc !== null ? (
            <HtmlRenderDialog
              src={expandedSrc}
              title={title}
              threadRef={props.threadRef}
              bridge={props.bridge}
              state={props.readState()}
              onClose={() => {
                setExpandedSrc(null);
                setInlineLoad((value) => value + 1);
              }}
            />
          ) : null}
        </>
      ) : failed ? (
        <p className="flex size-full items-center justify-center text-muted-foreground text-xs">
          Unable to load {title}
        </p>
      ) : null}
    </div>
  );
}
