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
import { T, useGT, Var } from "gt-react";
import { ChevronLeftIcon, ChevronRightIcon, Maximize2Icon } from "lucide-react";
import { useEffect, useState } from "react";

import { useAssetUrlRefresh } from "~/assets/assetUrls";
import { useLongLivedAssetUrl } from "~/assets/longLivedAssetUrls";
import { cn } from "~/lib/utils";
import {
  HTML_RENDER_SEEN_AFTER_MS,
  htmlRenderFrameInView,
} from "@t3tools/client-runtime/state/html-render";
import {
  htmlRenderEnvironment,
  htmlRenderStateStore,
  markHtmlRenderSeen,
} from "~/state/htmlRender";
import { type HtmlRenderOpenTarget, registerHtmlRenderOpener } from "~/state/htmlRenderOpenRequest";
import { useStableCallback } from "~/hooks/useStableCallback";
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
const MAX_MEASURED_CONTENT_HEIGHTS = 200;

// The height each render's page last reported, so a remounted frame opens at it before its page loads.
const measuredContentHeights = new Map<string, number>();

function rememberContentHeight(attachmentId: string, height: number) {
  measuredContentHeights.delete(attachmentId);
  measuredContentHeights.set(attachmentId, height);
  if (measuredContentHeights.size > MAX_MEASURED_CONTENT_HEIGHTS) {
    const oldest = measuredContentHeights.keys().next().value;
    if (oldest !== undefined) measuredContentHeights.delete(oldest);
  }
}

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
  const gt = useGT();
  const renderId = props.htmlRender.attachmentId;
  const last = props.versions.length - 1;
  const [selected, setSelected] = useState<number | null>(null);
  const index = selected === null ? last : Math.min(selected, last);
  const shown = props.versions[index]?.htmlRender ?? props.htmlRender;
  const select = (next: number) => setSelected(next >= last ? null : next);

  const { bridge, readState, stateReady, stateTarget } = useHtmlRenderPageBridge({
    environmentId: props.environmentId,
    threadRef: props.threadRef,
    renderId,
    title: shown.title,
    onSendMessage: props.onSendMessage,
  });

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
          openTarget={stateTarget}
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
            aria-label={gt("Previous version")}
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
                  aria-label={
                    index < last ? gt("Next version, a newer one exists") : gt("Next version")
                  }
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
              {index < last ? gt("A newer version exists") : gt("Newest version")}
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
  /** The page's identity for full-screen requests made outside the frame. */
  readonly openTarget: HtmlRenderOpenTarget | undefined;
  readonly onFullscreenChange?: ((fullscreen: boolean) => void) | undefined;
}) {
  const gt = useGT();
  const { attachmentId, title } = props.htmlRender;
  const { openTarget } = props;
  // Stable, so the frame's callback ref keeps its observers across renders.
  const markSeen = useStableCallback(() => {
    if (openTarget !== undefined) markHtmlRenderSeen({ ...openTarget, attachmentId });
  });
  const [width, setWidth] = useState(HTML_RENDER_COLUMN_WIDTH);
  // Client fonts can exceed the server-measured height and cause nested scrolling.
  const [contentHeight, setContentHeight] = useState(() =>
    measuredContentHeights.get(attachmentId),
  );
  // The page reports its height once it has loaded; before that the reader sees nothing.
  const [pageShown, setPageShown] = useState(false);
  const observeBox = (box: HTMLDivElement) => {
    setWidth(box.clientWidth);
    const stopResize = observeResize(box, ([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    const stopSeen = pageShown ? observeSeen(box, markSeen) : undefined;
    return () => {
      stopResize();
      stopSeen?.();
    };
  };
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
  const openFullScreen = async () => {
    const url =
      loaded !== null && loaded.expiresAt - Date.now() > MIN_URL_LIFE_MS
        ? src
        : await refresh().catch(() => null);
    if (url !== null) {
      setExpandedSrc(url);
      markSeen();
    } else
      toastManager.add({
        type: "error",
        title: gt("Page unavailable"),
        description: gt("Reconnect to the environment and try again."),
      });
  };
  const openFullScreenStable = useStableCallback(() => void openFullScreen());
  const openEnvironmentId = props.openTarget?.environmentId;
  const openThreadId = props.openTarget?.threadId;
  const openRenderId = props.openTarget?.renderId;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the page with the thread's ask line, which opens it full screen from outside the frame
  useEffect(() => {
    if (openEnvironmentId === undefined || openThreadId === undefined) return;
    if (openRenderId === undefined) return;
    return registerHtmlRenderOpener(
      { environmentId: openEnvironmentId, threadId: openThreadId, renderId: openRenderId },
      openFullScreenStable,
    );
  }, [openEnvironmentId, openThreadId, openRenderId, openFullScreenStable]);
  // The inline page reloads after full screen so it shows what was saved there.
  const [inlineLoad, setInlineLoad] = useState(0);
  const { onFullscreenChange } = props;
  // Tied to the viewer's lifetime: unmounting while expanded must still release
  // the timeline's follow pin, which a close handler alone never reaches.
  const expanded = expandedSrc !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds the parent's fullscreen pin while expanded and releases it on collapse or unmount
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
            containScroll
            onContentHeight={(height) => {
              rememberContentHeight(attachmentId, height);
              setContentHeight(height);
              setPageShown(true);
            }}
            onFullscreenChange={onFullscreenChange}
          />
          <div className="absolute end-2 top-2 flex gap-1 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/html-render:opacity-100 pointer-coarse:opacity-100">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label={gt("Open full screen")}
                    size="icon-xs"
                    variant="glass"
                    onClick={() => void openFullScreen()}
                  />
                }
              >
                <Maximize2Icon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="left">
                <T>Open full screen</T>
              </TooltipPopup>
            </Tooltip>
          </div>
        </>
      ) : failed ? (
        <p className="flex size-full items-center justify-center text-muted-foreground text-xs">
          <T>
            Unable to load <Var>{title}</Var>
          </T>
        </p>
      ) : null}
      {expandedSrc !== null ? (
        <HtmlRenderDialog
          src={expandedSrc}
          htmlRender={props.htmlRender}
          threadRef={props.threadRef}
          bridge={props.bridge}
          state={props.readState()}
          onClose={() => {
            setExpandedSrc(null);
            setInlineLoad((value) => value + 1);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Saved state and the `window.t3` bridge for one render, shared by its frame and a dialog opened
 * outside the timeline.
 */
export function useHtmlRenderPageBridge(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef | undefined;
  readonly renderId: string;
  readonly title: string;
  readonly onSendMessage:
    | ((text: string, context: OrchestrationMessageContext) => Promise<void>)
    | undefined;
}) {
  const { environmentId, renderId } = props;
  const savedState = useEnvironmentQuery(
    props.threadRef === undefined
      ? null
      : htmlRenderEnvironment.stateQuery({
          environmentId,
          input: { threadId: props.threadRef.threadId, renderId },
        }),
  );
  // Versions opened later, and later visits, must see what this tab saved, not the state read
  // at mount. The store also sends a page's last save when its frame goes away.
  const threadId = props.threadRef?.threadId;
  const stateTarget = threadId === undefined ? undefined : { environmentId, threadId, renderId };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Counts mounted views; the last one to leave sends the page's latest save.
  useEffect(() => {
    if (threadId === undefined) return;
    return htmlRenderStateStore.view({ environmentId, threadId, renderId });
  }, [environmentId, threadId, renderId]);
  // An older server lacks the state RPC; its pages still open, without saved state.
  const stateReady =
    props.threadRef === undefined || savedState.isSuccess || savedState.error !== null;
  const readState = () =>
    (stateTarget === undefined ? undefined : htmlRenderStateStore.read(stateTarget)) ??
    savedState.data ??
    NO_STATE;
  const { onSendMessage } = props;
  const bridge: HtmlRenderPageBridge | undefined =
    props.threadRef === undefined
      ? undefined
      : {
          environmentId,
          threadId: props.threadRef.threadId,
          renderId,
          title: props.title,
          onSendMessage:
            onSendMessage === undefined
              ? undefined
              : (message) => onSendMessage(message.text, message.context),
          onStateSaved: (state) => {
            if (stateTarget !== undefined) htmlRenderStateStore.save(stateTarget, state);
          },
        };
  return { bridge, readState, stateReady, stateTarget };
}

// Fine steps, so a tall frame's share of the screen is measured close to where it crosses half.
const SEEN_THRESHOLDS = Array.from({ length: 101 }, (_, step) => step / 100);

/**
 * Marks the shown version seen once the frame has stayed in view (`htmlRenderFrameInView`) for
 * a moment while the tab is visible. Hiding the tab stops the clock; showing it starts again.
 */
function observeSeen(box: HTMLElement, onSeen: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inView = false;
  const update = () => {
    if (!inView || document.visibilityState !== "visible") {
      clearTimeout(timer);
      timer = undefined;
      return;
    }
    timer ??= setTimeout(() => {
      timer = undefined;
      onSeen();
    }, HTML_RENDER_SEEN_AFTER_MS);
  };
  const observer = new IntersectionObserver(
    (entries) => {
      // One callback can carry several queued entries for this frame. Replay them in order, so
      // a moment out of view between two in-view entries restarts the clock.
      for (const entry of entries) {
        const visible = entry.isIntersecting ? entry.intersectionRect.height : 0;
        const frame = entry.boundingClientRect.height;
        const screen = entry.rootBounds?.height ?? window.innerHeight;
        inView =
          visible > 0 &&
          htmlRenderFrameInView({
            percentVisible: frame > 0 ? (visible / frame) * 100 : 0,
            percentOfScroller: screen > 0 ? (visible / screen) * 100 : 0,
          });
        update();
      }
    },
    { threshold: SEEN_THRESHOLDS },
  );
  observer.observe(box);
  document.addEventListener("visibilitychange", update);
  return () => {
    clearTimeout(timer);
    observer.disconnect();
    document.removeEventListener("visibilitychange", update);
  };
}
