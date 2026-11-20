import type { HtmlRenderPage, OrchestrationV2TurnItem } from "@t3tools/contracts";
import {
  HTML_RENDER_MIN_HEIGHT,
  htmlRenderVersion,
  type HtmlRenderReference,
  type HtmlRenderVersionEntry,
} from "@t3tools/shared/htmlRender";
import { htmlRenderFromToolItem, htmlRenderUpdateFromToolItem } from "@t3tools/shared/toolOutput";

import { HtmlRenderHostRefusal } from "../htmlRender/host.ts";
import type { EnvironmentThreadShell } from "./models.ts";
import { buildPendingUserInputAnswers, type PendingUserInputQuestion } from "./pendingUserInput.ts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "./runtime.ts";
import { oldestOpenAsk, sortThreadsByNeed, threadNeedsYou } from "./threadInbox.ts";
import type { PendingThreadRequests } from "./threadRequests.ts";
import { effectiveSnoozed, type ThreadSnoozeShell } from "./threadSettled.ts";

/** How long the triage Snooze hides a thread. */
export const TRIAGE_SNOOZE_MS = 60 * 60_000;

type DeckThreadInput = Parameters<typeof threadNeedsYou>[0] &
  ThreadSnoozeShell &
  Pick<EnvironmentThreadShell, "id" | "environmentId" | "updatedAt" | "archivedAt">;

/**
 * The triage deck: the threads the client's Needs you section lists, in its order. `isListed` is
 * the list's own filter (its project or environment filter, subagents under their parent), and
 * `honorsSnooze` tells whether the list applies a thread's snooze, as the list decides it.
 */
export function needsYouDeckThreads<T extends DeckThreadInput>(
  threads: readonly T[],
  options: {
    readonly now: string;
    readonly isListed: (thread: T) => boolean;
    readonly honorsSnooze: (thread: T) => boolean;
  },
): T[] {
  return sortThreadsByNeed(
    threads.filter(
      (thread) =>
        thread.archivedAt == null &&
        options.isListed(thread) &&
        !(options.honorsSnooze(thread) && effectiveSnoozed(thread, { now: options.now })) &&
        threadNeedsYou(thread) !== null,
    ),
  );
}

export function needsYouDeckKey(thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) {
  return `${thread.environmentId}:${thread.id}`;
}

/**
 * Where the user is in the deck. `order` is the deck as last reconciled, so a card that leaves
 * can hand over to the card that came after it.
 */
export interface NeedsYouDeck {
  readonly current: string | null;
  readonly order: readonly string[];
}

export const EMPTY_NEEDS_YOU_DECK: NeedsYouDeck = { current: null, order: [] };

function sameKeys(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

/**
 * The deck against its threads now: it stays on the current card while that card is there.
 * When it leaves (answered elsewhere, dismissed, snoozed), the card that came after it and is
 * still there comes next; when none is, the first card not before it, else the last card.
 * Returns the same object when nothing changed.
 */
export function reconcileNeedsYouDeck(deck: NeedsYouDeck, keys: readonly string[]): NeedsYouDeck {
  let current = deck.current;
  if (current === null || !keys.includes(current)) {
    const at = current === null ? -1 : deck.order.indexOf(current);
    const after = at === -1 ? [] : deck.order.slice(at + 1);
    const before = new Set(at === -1 ? [] : deck.order.slice(0, at));
    current =
      after.find((key) => keys.includes(key)) ??
      keys.find((key) => !before.has(key)) ??
      keys.at(-1) ??
      null;
  }
  if (current === deck.current && sameKeys(keys, deck.order)) return deck;
  return { current, order: keys };
}

/** The current card's index in `deck.order`, or -1 for an empty deck. Reconcile first. */
export function needsYouDeckIndex(deck: NeedsYouDeck): number {
  return deck.current === null ? -1 : deck.order.indexOf(deck.current);
}

/** Moves to the next or previous card, stopping at either end. Reconcile first. */
export function stepNeedsYouDeck(deck: NeedsYouDeck, delta: 1 | -1): NeedsYouDeck {
  const index = needsYouDeckIndex(deck);
  if (index === -1) return deck;
  const next = deck.order[Math.min(Math.max(index + delta, 0), deck.order.length - 1)] ?? null;
  return next === deck.current ? deck : { ...deck, current: next };
}

type NeedsYouDrafts = Readonly<Record<string, string>>;

function withDraft(drafts: NeedsYouDrafts, key: string, text: string): NeedsYouDrafts {
  if ((drafts[key] ?? "") === text) return drafts;
  const { [key]: _previous, ...rest } = drafts;
  return text.length === 0 ? rest : { ...rest, [key]: text };
}

export interface NeedsYouSession {
  readonly drafts: NeedsYouDrafts;
}

/** The client's command outbox, which keeps a message until it is delivered or dropped. */
export interface NeedsYouOutbox {
  /** Settles once it has read the messages it saved before the app started. */
  readonly loaded: () => Promise<unknown>;
  /** Whether it holds a message for the thread (by deck key), also one restored at app start. */
  readonly holdsThread: (key: string) => boolean;
  readonly subscribe: (listener: () => void) => () => void;
}

/** What a page's send from a card is refused with while the thread's last send is on its way. */
export const NEEDS_YOU_SEND_BUSY =
  "A reply to this thread is still on its way. Try again once it has gone out.";

/**
 * The replies started in triage, per thread, for the app session, and the sends still on their
 * way. Drafts outlive closing triage and a card leaving the deck, and a send that finishes after
 * triage closed still clears its own draft. A thread's send is on its way while it is handed over
 * and then while the outbox holds a message for the thread, offline or after a restart too.
 */
export function makeNeedsYouDraftStore(outbox: NeedsYouOutbox) {
  let session: NeedsYouSession = { drafts: {} };
  const handingOver = new Set<string>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const set = (key: string, text: string) => {
    const drafts = withDraft(session.drafts, key, text);
    if (drafts === session.drafts) return;
    session = { drafts };
    notify();
  };
  // Until the outbox has read what it saved, any thread may hold a reply. The read starts with the
  // first reader, since the clients start their outbox with the app, not with this store.
  let outboxLoaded = false;
  let loading: Promise<void> | null = null;
  const loadOutbox = () => {
    const done = () => {
      outboxLoaded = true;
      notify();
    };
    loading ??= outbox.loaded().then(done, done);
    return loading;
  };
  const sending = (key: string) => !outboxLoaded || handingOver.has(key) || outbox.holdsThread(key);
  /**
   * Sends for the thread unless a send of it is still on its way, and then resolves false. A send
   * with `text` that went out clears the draft only while it still holds that text.
   */
  const send = async (key: string, deliver: () => Promise<boolean>, text?: string) => {
    if (handingOver.has(key)) return false;
    handingOver.add(key);
    notify();
    let sent = false;
    try {
      if (!outboxLoaded) await loadOutbox();
      if (outbox.holdsThread(key)) return false;
      sent = await deliver();
    } finally {
      if (sent && text !== undefined && session.drafts[key] === text) set(key, "");
      handingOver.delete(key);
      notify();
    }
    return true;
  };
  return {
    getSnapshot: () => session,
    /** Also hears the outbox and starts its read, so `sending` can be read under it. */
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      const stop = outbox.subscribe(listener);
      void loadOutbox();
      return () => {
        listeners.delete(listener);
        stop();
      };
    },
    set,
    /** Whether a reply or answer of the thread is still on its way. */
    sending,
    send,
    /**
     * A page's `t3.send` from the card, one at a time with the card's own sends. The refusal
     * reaches the page, which may try again.
     */
    sendFromPage: async (key: string, deliver: () => Promise<boolean>) => {
      if (!(await send(key, deliver))) throw new HtmlRenderHostRefusal(NEEDS_YOU_SEND_BUSY);
    },
  };
}

type CardRow = { readonly item: OrchestrationV2TurnItem };

/** The agent's newest message in the thread's rows, or null before it said anything. */
function latestAssistantMessage(rows: ReadonlyArray<CardRow>) {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const item = rows[index]!.item;
    if (item.type === "assistant_message" && item.text.trim().length > 0) {
      return { itemId: item.id, text: item.text, streaming: item.streaming };
    }
  }
  return null;
}

/** A page's versions in the thread's rows, oldest first, or null when the rows do not hold it. */
function htmlRenderVersionsIn(
  rows: ReadonlyArray<CardRow>,
  renderId: string,
): HtmlRenderVersionEntry[] | null {
  let versions: HtmlRenderVersionEntry[] | null = null;
  for (const { item } of rows) {
    if (item.type !== "dynamic_tool" || item.status !== "completed") continue;
    if (versions === null) {
      const render = htmlRenderFromToolItem(item);
      if (render?.attachmentId === renderId) versions = [{ itemId: item.id, htmlRender: render }];
      continue;
    }
    const update = htmlRenderUpdateFromToolItem(item);
    if (update?.renderId !== renderId) continue;
    versions.push({
      itemId: item.id,
      htmlRender: htmlRenderVersion(versions.at(-1)!.htmlRender, update),
    });
  }
  return versions;
}

type IndexedPage = Pick<HtmlRenderPage, "renderId" | "latestAttachmentId" | "title">;

/**
 * What a page card mounts: the page's versions in the loaded timeline, or else the page index's
 * newest version, mounted under the page's render id so its saved state and answers stay with
 * the page. Null while neither holds the page.
 */
export function needsYouPageFrame(
  page: { readonly renderId: string; readonly versions: HtmlRenderVersionEntry[] | null },
  indexed: ReadonlyArray<IndexedPage> | null,
): {
  readonly render: HtmlRenderReference;
  readonly versions: ReadonlyArray<HtmlRenderVersionEntry>;
} | null {
  const first = page.versions?.[0];
  if (page.versions !== null && first !== undefined) {
    return { render: first.htmlRender, versions: page.versions };
  }
  const row = indexed?.find((candidate) => candidate.renderId === page.renderId);
  if (row === undefined) return null;
  const reference = (attachmentId: string) => ({
    attachmentId,
    title: row.title,
    height: HTML_RENDER_MIN_HEIGHT,
  });
  return {
    render: reference(row.renderId),
    versions: [{ itemId: row.latestAttachmentId, htmlRender: reference(row.latestAttachmentId) }],
  };
}

/**
 * The answers a card sends for its question, built as the thread's own question card builds
 * them: a picked option resolves to the option's value, typed text as the question takes it.
 * Null when there is nothing to send.
 */
export function needsYouAnswers(
  question: PendingUserInputQuestion,
  reply: { readonly option: string } | { readonly text: string },
) {
  return buildPendingUserInputAnswers([question], {
    [question.id]:
      "option" in reply ? { selectedOptionValues: [reply.option] } : { customAnswer: reply.text },
  });
}

/**
 * Whether a card's answer went out. An interrupted one may not have reached the environment, so
 * it keeps its draft like any failure, but only a failure that is not an interrupt is reported.
 */
export function needsYouAnswerSent(
  result: AtomCommandResult<unknown, unknown>,
  report: (error: unknown) => void,
): boolean {
  if (result._tag === "Success") return true;
  if (!isAtomCommandInterrupted(result)) report(squashAtomCommandFailure(result));
  return false;
}

/**
 * What a card offers for its thread. A thread's own reply ends its asks; a single question is
 * answered with one of its options or, when it allows one, typed text. Approvals, requests,
 * questions with several parts and prompts that hand the user text to edit open the thread instead.
 */
export function needsYouCard(input: {
  readonly thread: Parameters<typeof threadNeedsYou>[0];
  readonly rows: ReadonlyArray<CardRow>;
  /** The thread's pending requests, or null while its detail loads. */
  readonly requests: PendingThreadRequests | null;
}) {
  const need = threadNeedsYou(input.thread);
  const ask = oldestOpenAsk(input.thread);
  const pending = need?.kind === "question" ? input.requests?.userInputs[0] : undefined;
  const approval = need?.kind === "approval" ? input.requests?.approvals[0] : undefined;
  const only = pending?.questions.length === 1 ? pending.questions[0] : undefined;
  const question =
    pending !== undefined &&
    only !== undefined &&
    only.multiSelect !== true &&
    only.initialAnswer === undefined &&
    pending.responseCapability !== "not_resumable"
      ? { requestId: pending.requestId, ...only }
      : null;
  const replyMode: "message" | "answer" | null =
    need?.kind === "turn_end" || need?.kind === "page"
      ? "message"
      : question !== null && question.allowCustomAnswer !== false
        ? "answer"
        : null;
  return {
    need,
    latest: latestAssistantMessage(input.rows),
    page:
      need?.kind === "page" && ask?.source.type === "page"
        ? {
            renderId: ask.source.renderId,
            versions: htmlRenderVersionsIn(input.rows, ask.source.renderId),
          }
        : null,
    question,
    /** What a card that opens the thread waits on: each question, or what the approval is for. */
    waitingOn:
      question !== null
        ? []
        : (pending?.questions.map((entry) => entry.question) ??
          [approval?.detail ?? approval?.reason].filter((text) => text !== undefined)),
    replyMode,
    answersHere: replyMode !== null || question !== null,
    hasOpenAsks: (input.thread.openAsks?.length ?? 0) > 0,
  };
}
