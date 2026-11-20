import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { threadNeedsYou } from "@t3tools/client-runtime/state/thread-inbox";
import { NEEDS_YOU_WS_METHODS, type NeedsYouSubject, type ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

/** A subject published longer ago than this is history, such as one sent while no tab was open. */
export const WEB_ALERT_FRESH_MS = 10 * 60_000;
const CLAIMS_STORAGE_KEY = "t3code:needs-you-claims";
const CURSOR_STORAGE_PREFIX = "t3code:needs-you-cursor:";
const CLAIM_RETENTION_MS = 2 * 24 * 60 * 60_000;

/**
 * The subjects of a snapshot this browser has not seen, and the cursor after them. Without a
 * cursor (the first time this browser watches the environment) nothing is new: what was published
 * before is history.
 */
export function newSubjects(
  subjects: ReadonlyArray<NeedsYouSubject>,
  cursor: number | null,
): { readonly subjects: ReadonlyArray<NeedsYouSubject>; readonly cursor: number } {
  const latest = subjects.reduce((max, subject) => Math.max(max, subject.version), cursor ?? 0);
  return {
    subjects: cursor === null ? [] : subjects.filter((subject) => subject.version > cursor),
    cursor: latest,
  };
}

/**
 * The cursor a reload starts from: before the oldest subject this tab still waits to present, such
 * as one whose thread it has not loaded yet.
 */
export function cursorToKeep(cursor: number, waiting: Iterable<NeedsYouSubject>): number {
  let kept = cursor;
  for (const subject of waiting) kept = Math.min(kept, subject.version - 1);
  return kept;
}

/** How a tab shows an alert. "seen" is a focused tab already showing the thread. */
export type PresentationChannel = "system" | "toast" | "sound" | "seen";

/**
 * How this tab can present a subject right now, or null when it leaves it to another tab. The tab
 * claims a subject only through the channel it then presents it in. Reminders and the digest are
 * system notifications whenever those are on, even in a focused tab; other alerts become a toast
 * in a focused tab and a system notification in a background one.
 */
export function presentationChannel(input: {
  readonly scheduled: boolean;
  /** System notifications are on and the browser allows them. */
  readonly system: boolean;
  readonly sound: boolean;
  readonly focused: boolean;
  readonly toasts: boolean;
  /** This tab shows the subject's thread. */
  readonly viewing: boolean;
}): PresentationChannel | null {
  if (input.scheduled) {
    if (input.system) return "system";
    if (input.focused && input.toasts) return "toast";
    return input.sound ? "sound" : null;
  }
  if (input.focused && input.viewing) return "seen";
  if (input.focused && input.toasts) return "toast";
  if (!input.focused && input.system) return "system";
  return input.sound ? "sound" : null;
}

function readClaims(storage: Pick<Storage, "getItem">): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(CLAIMS_STORAGE_KEY) ?? "{}");
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

// Subject ids are unique within an environment only: every server has a `digest:<date>`.
const claimKey = (environmentId: string, id: string) => `${environmentId}/${id}`;

const claimLive = (at: unknown, nowMs: number): boolean =>
  typeof at === "number" && nowMs - at < CLAIM_RETENTION_MS;

/** Whether a tab of this browser presented the environment's subject in the last two days. */
export function claimedNeedsYouSubject(
  storage: Pick<Storage, "getItem"> | null,
  environmentId: string,
  id: string,
  nowMs: number,
): boolean {
  return storage !== null && claimLive(readClaims(storage)[claimKey(environmentId, id)], nowMs);
}

/**
 * Claims a subject for this browser, so only one tab presents it and a reload does not present it
 * again. Returns whether this call claimed it. Callers hold the claims lock, so two tabs never
 * read the same claims.
 */
export function claimNeedsYouSubject(
  storage: Pick<Storage, "getItem" | "setItem"> | null,
  environmentId: string,
  id: string,
  nowMs: number,
): boolean {
  if (storage === null) return true;
  const key = claimKey(environmentId, id);
  const kept = Object.fromEntries(
    Object.entries(readClaims(storage)).filter(([, at]) => claimLive(at, nowMs)),
  );
  if (key in kept) return false;
  try {
    storage.setItem(CLAIMS_STORAGE_KEY, JSON.stringify({ ...kept, [key]: nowMs }));
  } catch {
    // Storage can be full or blocked; presenting twice beats never presenting.
  }
  return true;
}

/** The last subject version this browser saw from an environment, kept across reloads. */
export function readNeedsYouCursor(
  storage: Pick<Storage, "getItem"> | null,
  environmentId: string,
): number | null {
  const value = Number(storage?.getItem(`${CURSOR_STORAGE_PREFIX}${environmentId}`) ?? Number.NaN);
  return Number.isInteger(value) ? value : null;
}

export function writeNeedsYouCursor(
  storage: Pick<Storage, "getItem" | "setItem"> | null,
  environmentId: string,
  cursor: number,
): void {
  const key = `${CURSOR_STORAGE_PREFIX}${environmentId}`;
  try {
    // Another tab may have read further.
    if ((readNeedsYouCursor(storage, environmentId) ?? -1) < cursor) {
      storage?.setItem(key, String(cursor));
    }
  } catch {
    // Without storage the cursor lives as long as the page.
  }
}

/** The lock every tab of this origin takes around reading and writing the claims. */
export const NEEDS_YOU_CLAIMS_LOCK = CLAIMS_STORAGE_KEY;

/** Where an environment's alerts come from. */
export type NeedsYouSource = "stream" | "shells";

/**
 * The needs-you stream once it answers, or the shells on a server built before it, which reports
 * `needsYou.subscribe` as an unknown method. The first answer decides for as long as the
 * environment is watched.
 */
export function needsYouSource(
  previous: NeedsYouSource | null,
  result: AsyncResult.AsyncResult<unknown, unknown>,
): NeedsYouSource | null {
  if (previous !== null) return previous;
  if (AsyncResult.isSuccess(result)) return "stream";
  if (!AsyncResult.isFailure(result)) return null;
  const unknownMethod = result.cause.reasons.some(
    (reason) =>
      reason._tag === "Die" &&
      reason.defect === `Unknown request tag: ${NEEDS_YOU_WS_METHODS.subscribe}`,
  );
  return unknownMethod ? "shells" : null;
}

type ShellAlertThread = Parameters<typeof threadNeedsYou>[0] &
  Pick<EnvironmentThreadShell, "id"> & {
    readonly latestRun: Pick<
      NonNullable<EnvironmentThreadShell["latestRun"]>,
      "runId" | "status" | "completedAt"
    > | null;
  };

/** What a thread alerts about on a server without the needs-you stream: its need, a failed run. */
function shellAlertSubjects(thread: ShellAlertThread, now: string): ReadonlyArray<NeedsYouSubject> {
  const subjects: Array<NeedsYouSubject> = [];
  const base = {
    threadId: thread.id,
    version: 0,
    publishedAt: now,
    resolved: false,
    superseded: false,
  };
  const need = threadNeedsYou(thread);
  if (need !== null) {
    subjects.push({
      ...base,
      id: `shell:${thread.id}/${need.kind}:${need.since ?? ""}`,
      source:
        need.kind === "guest"
          ? "guest"
          : need.kind === "turn_end" || need.kind === "page"
            ? "ask"
            : "request",
      kind:
        need.kind === "approval" ||
        (need.kind === "subagent" && thread.pendingSubagentRequest === "approval")
          ? "approval"
          : "input",
      at: need.since ?? now,
    });
  }
  const run = thread.latestRun;
  if (run?.status === "failed") {
    subjects.push({
      ...base,
      id: `shell:${thread.id}/failed:${run.runId}`,
      source: "run",
      kind: "failed",
      at: run.completedAt ?? now,
    });
  }
  return subjects;
}

/** The subjects each thread had since it last had none. */
export type ShellAlertsSeen = ReadonlyMap<ThreadId, ReadonlySet<string>>;

/**
 * The shell subjects that are new since the last observation, and the ones open now. What the
 * first observation finds, and a thread's first sighting, are history. A thread alerts each
 * subject once until it has none again, so a need that returns after a later one ended is quiet.
 */
export function shellAlerts(
  seen: ShellAlertsSeen | null,
  threads: ReadonlyArray<ShellAlertThread>,
  now: string,
): {
  readonly alerts: ReadonlyArray<NeedsYouSubject>;
  readonly open: ReadonlySet<string>;
  readonly seen: ShellAlertsSeen;
} {
  const alerts: Array<NeedsYouSubject> = [];
  const open = new Set<string>();
  const next = new Map<ThreadId, ReadonlySet<string>>();
  for (const thread of threads) {
    const subjects = shellAlertSubjects(thread, now);
    const before = seen?.get(thread.id);
    for (const subject of subjects) {
      open.add(subject.id);
      if (before !== undefined && !before.has(subject.id)) alerts.push(subject);
    }
    const ids = subjects.map((subject) => subject.id);
    next.set(thread.id, ids.length === 0 ? new Set() : new Set([...(before ?? []), ...ids]));
  }
  return { alerts, open, seen: next };
}
