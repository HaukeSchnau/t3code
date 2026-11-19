import type {
  EnvironmentId,
  HtmlRenderPage,
  OrchestrationMessageContext,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { HTML_RENDER_MIN_HEIGHT, htmlRenderFileName } from "@t3tools/shared/htmlRender";
import { useEffect } from "react";

import { useLongLivedAssetUrl } from "~/assets/longLivedAssetUrls";
import { markHtmlRenderSeen } from "~/state/htmlRender";

import { toastManager } from "../ui/toast";
import { useHtmlRenderPageBridge } from "./HtmlRenderFrame";
import { HtmlRenderDialog } from "./HtmlRenderDialog";

export type HtmlRenderPageTarget = Pick<
  HtmlRenderPage,
  "renderId" | "threadId" | "latestAttachmentId" | "title"
>;

/**
 * A page's newest version full screen, for pages the loaded timeline does not hold. It answers
 * through the same bridge as the timeline's frame. Opening it counts as seeing that version.
 */
export function HtmlRenderPageDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly page: HtmlRenderPageTarget;
  readonly onSendMessage:
    | ((text: string, context: OrchestrationMessageContext) => Promise<void>)
    | undefined;
  readonly onClose: () => void;
}) {
  const { page } = props;
  const { bridge, readState, stateReady } = useHtmlRenderPageBridge({
    environmentId: props.environmentId,
    threadRef: props.threadRef,
    renderId: page.renderId,
    title: page.title,
    onSendMessage: props.onSendMessage,
  });
  const asset = useLongLivedAssetUrl(props.environmentId, {
    _tag: "attachment",
    attachmentId: page.latestAttachmentId,
    fileName: htmlRenderFileName(page.title),
    mimeType: "text/html",
    disposition: "inline",
  });
  const failed = asset._tag === "Failure";
  const shown = stateReady && asset._tag === "Success";
  const { environmentId } = props;
  const { threadId, renderId, latestAttachmentId } = page;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the server the reader saw this version once the dialog shows it
  useEffect(() => {
    if (!shown) return;
    markHtmlRenderSeen({ environmentId, threadId, renderId, attachmentId: latestAttachmentId });
  }, [shown, environmentId, threadId, renderId, latestAttachmentId]);
  const { onClose } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the reader why the page they clicked did not open, once its URL request fails
  useEffect(() => {
    if (!failed) return;
    toastManager.add({
      type: "error",
      title: "Page unavailable",
      description: "Reconnect to the environment and try again.",
    });
    onClose();
  }, [failed, onClose]);
  if (!shown || asset._tag !== "Success") return null;
  return (
    <HtmlRenderDialog
      src={asset.url}
      htmlRender={{
        attachmentId: page.latestAttachmentId,
        title: page.title,
        height: HTML_RENDER_MIN_HEIGHT,
      }}
      threadRef={props.threadRef}
      bridge={bridge}
      state={readState()}
      onClose={props.onClose}
    />
  );
}
