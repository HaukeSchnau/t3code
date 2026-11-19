import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { triagePageSend } from "../needs-you/triageSession";
import type { HtmlRenderBridgeTarget } from "../threads/HtmlRenderWebView";

/** The bridge of a page opened full screen, which reaches its thread when the route names one. */
export function htmlRenderRouteBridge(params: {
  readonly environmentId?: string;
  readonly threadId?: string;
  readonly renderId?: string;
  readonly triage?: "1";
}): HtmlRenderBridgeTarget | undefined {
  if (!params.environmentId?.trim() || params.threadId === undefined || !params.renderId) {
    return undefined;
  }
  const thread = {
    environmentId: EnvironmentId.make(params.environmentId),
    threadId: ThreadId.make(params.threadId),
  };
  return {
    ...thread,
    renderId: params.renderId,
    send: params.triage === "1" ? triagePageSend(thread) : undefined,
  };
}
