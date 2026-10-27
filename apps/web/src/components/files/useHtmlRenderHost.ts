import { HtmlRenderHostRefusal, makeHtmlRenderHost } from "@t3tools/client-runtime/html-render";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  HtmlRenderState,
  OrchestrationMessageContext,
  ThreadId,
} from "@t3tools/contracts";
import { type RefObject, useEffect, useEffectEvent } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { htmlRenderEnvironment } from "~/state/htmlRender";
import { useAtomCommand } from "~/state/use-atom-command";

/** What a page shown in a thread may reach through `window.t3`. */
export interface HtmlRenderPageBridge {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly renderId: string;
  readonly title: string;
  /** Undefined where this view cannot send, such as a held timeline. */
  readonly onSendMessage:
    | ((message: {
        readonly text: string;
        readonly context: OrchestrationMessageContext;
      }) => Promise<void>)
    | undefined;
  readonly onStateSaved: (state: HtmlRenderState) => void;
}

const commandFailure = (result: {
  readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"];
}) => {
  const error = squashAtomCommandFailure(result);
  return new HtmlRenderHostRefusal(
    error instanceof Error && error.message.trim() !== "" ? error.message : "Request failed.",
  );
};

/** Answers the page's `window.t3` requests; without a bridge it can only copy. */
export function useHtmlRenderHost(
  frameRef: RefObject<HTMLIFrameElement | null>,
  bridge: HtmlRenderPageBridge | undefined,
) {
  const callTool = useAtomCommand(htmlRenderEnvironment.callTool, { reportFailure: false });
  const setState = useAtomCommand(htmlRenderEnvironment.setState, { reportFailure: false });
  const readLive = useEffectEvent(() => ({ bridge, callTool, setState }));
  const bridged = bridge !== undefined;
  // oxlint-disable-next-line t3code/react-effect-budget -- The page posts to this window; listen while the frame is mounted.
  useEffect(() => {
    const target = () => frameRef.current?.contentWindow ?? null;
    const live = () => {
      const current = readLive().bridge;
      if (current === undefined) throw new HtmlRenderHostRefusal("This page has no thread.");
      return current;
    };
    const host = makeHtmlRenderHost({
      // Opaque origins require "*"; the window reference scopes delivery to this frame.
      post: (message) => target()?.postMessage(message, "*"),
      copy: (text) => navigator.clipboard.writeText(text),
      // Each page document gets its own host, so its render and title are fixed for the host's life.
      bridge: bridged
        ? {
            renderId: live().renderId,
            title: live().title,
            send: async (message) => {
              const send = live().onSendMessage;
              if (send === undefined) {
                throw new HtmlRenderHostRefusal("Messages are not available here.");
              }
              await send(message);
            },
            callTool: async (input) => {
              const { environmentId, threadId, renderId } = live();
              const result = await readLive().callTool({
                environmentId,
                input: { threadId, renderId, ...input },
              });
              if (result._tag !== "Success") throw commandFailure(result);
              return result.value;
            },
            confirm: async ({ page, tool, arguments: args }) => {
              const approved = await requestConfirmDialog(
                `Allow ${page} to run ${tool}?\n${JSON.stringify(args, null, 2)}`,
              );
              if (approved === undefined) {
                throw new HtmlRenderHostRefusal("T3 could not ask for approval here.");
              }
              return approved;
            },
            saveState: (state) => {
              const { environmentId, threadId, renderId, onStateSaved } = live();
              onStateSaved(state);
              void readLive().setState({
                environmentId,
                input: { threadId, renderId, state },
              });
            },
          }
        : undefined,
    });
    const receive = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (frame === null || event.source !== frame.contentWindow) return;
      host.receive(event.data, {
        active: document.activeElement === frame && navigator.userActivation?.isActive !== false,
      });
    };
    window.addEventListener("message", receive);
    return () => {
      window.removeEventListener("message", receive);
      host.dispose();
    };
  }, [frameRef, bridged]);
}
