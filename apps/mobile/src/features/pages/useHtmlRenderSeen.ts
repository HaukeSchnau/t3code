import { useAtomValue } from "@effect/atom-react";
import { useIsFocused } from "@react-navigation/native";
import {
  HTML_RENDER_SEEN_AFTER_MS,
  type HtmlRenderSeenTarget,
} from "@t3tools/client-runtime/state/html-render";
import type { EnvironmentId } from "@t3tools/contracts";
import { use, useEffect } from "react";

import { useAppActive } from "../../lib/appState";
import { htmlRenderEnvironment, htmlRenderSeenMarker } from "../../state/htmlRender";
import { HtmlRenderInViewContext } from "./pagePresentation";

function useCanMarkSeen(environmentId: EnvironmentId | null) {
  return useAtomValue(htmlRenderEnvironment.markSeen.permissionAtom(environmentId));
}

/**
 * Marks a feed row's page seen once it has stayed in view for a moment while the app is in the
 * foreground and the thread's screen is on top (a screen pushed over it keeps the feed mounted).
 * The feed row measures what it shows; outside the feed this never marks.
 */
export function useMarkHtmlRenderSeenInView(target: HtmlRenderSeenTarget | null) {
  const canMark = useCanMarkSeen(target?.environmentId ?? null);
  const active = useAppActive();
  const focused = useIsFocused();
  const inView = use(HtmlRenderInViewContext);
  const armed = target !== null && canMark && active && focused && inView;
  const environmentId = target?.environmentId;
  const threadId = target?.threadId;
  const renderId = target?.renderId;
  const attachmentId = target?.attachmentId;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- times how long the page stays in view before telling the server it was seen
  useEffect(() => {
    if (
      !armed ||
      environmentId === undefined ||
      threadId === undefined ||
      renderId === undefined ||
      attachmentId === undefined
    )
      return;
    const timer = setTimeout(
      () => htmlRenderSeenMarker({ environmentId, threadId, renderId, attachmentId }),
      HTML_RENDER_SEEN_AFTER_MS,
    );
    return () => clearTimeout(timer);
  }, [armed, environmentId, threadId, renderId, attachmentId]);
}

/** Marks a page seen when its full-screen view opens. */
export function useMarkHtmlRenderSeenOnOpen(target: HtmlRenderSeenTarget | null) {
  const canMark = useCanMarkSeen(target?.environmentId ?? null);
  const environmentId = target?.environmentId;
  const threadId = target?.threadId;
  const renderId = target?.renderId;
  const attachmentId = target?.attachmentId;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the server the reader opened this version
  useEffect(() => {
    if (
      !canMark ||
      environmentId === undefined ||
      threadId === undefined ||
      renderId === undefined ||
      attachmentId === undefined
    )
      return;
    htmlRenderSeenMarker({ environmentId, threadId, renderId, attachmentId });
  }, [canMark, environmentId, threadId, renderId, attachmentId]);
}
