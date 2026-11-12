// @effect-diagnostics globalTimers:off - plain Promise code shared by React clients; debounces run outside any Effect runtime.
import type { EnvironmentId, HtmlRenderState, ThreadId } from "@t3tools/contracts";

export interface HtmlRenderStateTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly renderId: string;
}

const WRITE_DELAY_MS = 300;

interface Entry {
  readonly target: HtmlRenderStateTarget;
  state: HtmlRenderState | undefined;
  views: number;
  dirty: boolean;
  writing: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const keyOf = (target: HtmlRenderStateTarget) =>
  `${target.environmentId}\u0000${target.threadId}\u0000${target.renderId}`;

/**
 * What pages saved on this device that the server may not have yet, or that views mounted
 * before the save would otherwise miss. Writes are debounced and sent when the last view goes
 * away, so a reader who leaves right after a change keeps it. An entry outlives its views only
 * until its write lands; a later visit then reads what other devices saved since.
 */
export function makeHtmlRenderStateStore(options: {
  /** Resolves true once the server stored the state. */
  readonly write: (target: HtmlRenderStateTarget, state: HtmlRenderState) => Promise<boolean>;
}) {
  const entries = new Map<string, Entry>();

  const entryFor = (target: HtmlRenderStateTarget) => {
    const key = keyOf(target);
    let entry = entries.get(key);
    if (entry === undefined) {
      entry = {
        target,
        state: undefined,
        views: 0,
        dirty: false,
        writing: false,
        timer: undefined,
      };
      entries.set(key, entry);
    }
    return entry;
  };

  const prune = (entry: Entry) => {
    if (entry.views === 0 && !entry.dirty && !entry.writing) {
      entries.delete(keyOf(entry.target));
    }
  };

  // One write in flight per render, so the server never ends on an older save.
  const write = (entry: Entry) => {
    clearTimeout(entry.timer);
    entry.timer = undefined;
    if (entry.writing || !entry.dirty || entry.state === undefined) return;
    entry.dirty = false;
    entry.writing = true;
    const settle = (stored: boolean) => {
      entry.writing = false;
      // A failed write stays local and goes out with the next save or flush.
      if (!stored) entry.dirty = true;
      else if (entry.dirty && entry.timer === undefined) write(entry);
      prune(entry);
    };
    options.write(entry.target, entry.state).then(settle, () => settle(false));
  };

  return {
    /** Registers a mounted view; the returned release sends the latest save if it was the last. */
    view: (target: HtmlRenderStateTarget) => {
      const entry = entryFor(target);
      entry.views += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        entry.views -= 1;
        if (entry.views === 0) write(entry);
        prune(entry);
      };
    },
    read: (target: HtmlRenderStateTarget) => entries.get(keyOf(target))?.state,
    save: (target: HtmlRenderStateTarget, state: HtmlRenderState) => {
      const entry = entryFor(target);
      entry.state = state;
      entry.dirty = true;
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => write(entry), WRITE_DELAY_MS);
    },
    /** Sends every pending save now, such as when the app leaves the foreground. */
    flush: () => {
      for (const entry of entries.values()) write(entry);
    },
  };
}

export type HtmlRenderStateStore = ReturnType<typeof makeHtmlRenderStateStore>;
