import {
  type EnvironmentId,
  type HtmlRenderPage,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

interface PageScope {
  readonly environmentId: EnvironmentId;
  /** One thread's pages; without it, every thread's. */
  readonly threadId?: ThreadId | undefined;
}

export function createHtmlRenderEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const pageChanges = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:html-render:page-changes",
    tag: WS_METHODS.htmlRenderSubscribePageChanges,
    idleTtlMs: 60_000,
  });
  const pageChange = (scope: PageScope) =>
    pageChanges({
      environmentId: scope.environmentId,
      input: scope.threadId === undefined ? {} : { threadId: scope.threadId },
    });
  // Null until the stream's first answer. A list read before that answer can miss a page
  // published before the server subscribed, so the answer reloads it. A list mounted after the
  // answer, such as the chip's popover, loads once.
  const pageRevision = Atom.family((key: string) => {
    const scope = JSON.parse(key) as PageScope;
    return Atom.make(
      (get) => AsyncResult.getOrElse(get(pageChange(scope)), () => null)?.revision ?? null,
    ).pipe(Atom.withLabel(`environment-data:html-render:page-revision:${key}`));
  });
  const scopeKey = (scope: PageScope) =>
    JSON.stringify({ environmentId: scope.environmentId, threadId: scope.threadId });
  const pageCount = Atom.family((key: string) => {
    const scope = JSON.parse(key) as PageScope;
    return Atom.make(
      (get) => AsyncResult.getOrElse(get(pageChange(scope)), () => null)?.pages ?? null,
    ).pipe(Atom.withLabel(`environment-data:html-render:page-count:${key}`));
  });
  return {
    /** Read fresh on every mount: another device may have written since. */
    stateQuery: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:html-render:state",
      tag: WS_METHODS.htmlRenderGetState,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
    setState: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:html-render:set-state",
      tag: WS_METHODS.htmlRenderSetState,
    }),
    callTool: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:html-render:call-tool",
      tag: WS_METHODS.htmlRenderCallTool,
    }),
    /**
     * Reloads when a page it may show is published or seen, or its thread's asks, title or
     * deletion change, on any device. A thread's list reloads for that thread only.
     */
    pages: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:html-render:pages",
      tag: WS_METHODS.htmlRenderListPages,
      refreshTrigger: ({ environmentId, input }) =>
        pageRevision(scopeKey({ environmentId, threadId: input.threadId })),
    }),
    /** How many pages the thread has, without loading them; null until the server answers. */
    threadPageCount: (scope: Required<PageScope>) => pageCount(scopeKey(scope)),
    markSeen: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:html-render:mark-seen",
      tag: WS_METHODS.htmlRenderMarkSeen,
    }),
  };
}

export interface HtmlRenderSeenTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly renderId: string;
  /** The version the reader saw; a newer one is new again. */
  readonly attachmentId: string;
}

/**
 * Marks each version seen once per app session. Clients call it when a page's frame stays at
 * least half visible for {@link HTML_RENDER_SEEN_AFTER_MS}, or its full-screen view opens.
 */
export function makeHtmlRenderSeenMarker(options: {
  /** Resolves true once the server stored the mark. */
  readonly mark: (target: HtmlRenderSeenTarget) => Promise<boolean>;
}) {
  const marked = new Set<string>();
  return (target: HtmlRenderSeenTarget) => {
    const key = `${target.environmentId}\u0000${target.threadId}\u0000${target.renderId}\u0000${target.attachmentId}`;
    if (marked.has(key)) return;
    marked.add(key);
    void options.mark(target).then(
      (stored) => stored || marked.delete(key),
      () => marked.delete(key),
    );
  };
}

export const HTML_RENDER_SEEN_AFTER_MS = 1_500;
const HTML_RENDER_SEEN_VISIBLE_RATIO = 0.5;

/**
 * Half the frame is on screen. A frame more than twice the screen's height never is, so one
 * that covers half the screen counts too.
 */
export function htmlRenderFrameInView(amount: {
  readonly percentVisible: number;
  readonly percentOfScroller: number;
}) {
  const percent = HTML_RENDER_SEEN_VISIBLE_RATIO * 100;
  return amount.percentVisible >= percent || amount.percentOfScroller >= percent;
}

/** A thread's pages as its Pages list shows them: waiting for the reader, new, then seen. */
export function groupHtmlRenderPages(pages: ReadonlyArray<HtmlRenderPage>) {
  const asks: Array<HtmlRenderPage> = [];
  const unseen: Array<HtmlRenderPage> = [];
  const seen: Array<HtmlRenderPage> = [];
  for (const page of pages) {
    if (page.ask !== null) asks.push(page);
    else if (page.seenAt === null) unseen.push(page);
    else seen.push(page);
  }
  return { asks, unseen, seen };
}
