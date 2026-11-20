import type { NeedsYouSubject } from "@t3tools/contracts";
import { NEEDS_YOU_WS_METHODS, RunId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  claimedNeedsYouSubject,
  claimNeedsYouSubject,
  cursorToKeep,
  needsYouSource,
  newSubjects,
  presentationChannel,
  readNeedsYouCursor,
  type ShellAlertsSeen,
  shellAlerts,
  writeNeedsYouCursor,
} from "./ThreadNotificationCoordinator.logic";

const subject = (id: string, version: number): NeedsYouSubject => ({
  id,
  version,
  source: "ask",
  kind: "input",
  threadId: ThreadId.make("thread"),
  at: "2026-11-19T17:00:00.000Z",
  publishedAt: "2026-11-19T17:00:00.000Z",
  resolved: false,
  superseded: false,
});

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

describe("newSubjects", () => {
  it("treats what a first-time browser finds as history, then each version once", () => {
    const ask = subject("ask:a", 2);
    const first = newSubjects([subject("run:r", 1), ask], null);
    expect(first).toEqual({ subjects: [], cursor: 2 });
    // The same snapshot again, such as after a reconnect or while a thread is archived and
    // unarchived, has nothing new.
    expect(newSubjects([subject("run:r", 1), ask], first.cursor).subjects).toEqual([]);
    const request = subject("request:q", 3);
    expect(newSubjects([ask, request], first.cursor)).toEqual({
      subjects: [request],
      cursor: 3,
    });
  });

  it("resumes after a reload from the version the browser saw last", () => {
    const storage = memoryStorage();
    expect(readNeedsYouCursor(storage, "env")).toBeNull();
    writeNeedsYouCursor(storage, "env", 4);
    // Another tab that read less does not move it back.
    writeNeedsYouCursor(storage, "env", 3);
    expect(readNeedsYouCursor(storage, "env")).toBe(4);
    expect(
      newSubjects([subject("ask:a", 4), subject("ask:b", 5)], readNeedsYouCursor(storage, "env"))
        .subjects,
    ).toEqual([subject("ask:b", 5)]);
    // A subject still waiting for its thread to load keeps the saved cursor before it.
    expect(cursorToKeep(7, [subject("ask:c", 6), subject("ask:d", 7)])).toBe(5);
    expect(cursorToKeep(7, [])).toBe(7);
  });
});

describe("presentationChannel", () => {
  const tab = {
    scheduled: false,
    system: false,
    sound: false,
    focused: false,
    toasts: false,
    viewing: false,
  };

  it("claims a notice only through the channel the tab presents it in", () => {
    // The digest and reminders are system notifications whenever those are on, focused or not.
    expect(presentationChannel({ ...tab, scheduled: true, system: true, focused: true })).toBe(
      "system",
    );
    expect(presentationChannel({ ...tab, scheduled: true, focused: true, toasts: true })).toBe(
      "toast",
    );
    // A background tab without system notifications cannot show a toast: only its sound.
    expect(presentationChannel({ ...tab, scheduled: true, toasts: true, sound: true })).toBe(
      "sound",
    );
    expect(presentationChannel({ ...tab, scheduled: true, toasts: true })).toBeNull();
    // Alerts: a toast in a focused tab, a system notification in a background one.
    expect(presentationChannel({ ...tab, system: true, focused: true, toasts: true })).toBe(
      "toast",
    );
    expect(presentationChannel({ ...tab, system: true, toasts: true })).toBe("system");
    expect(presentationChannel({ ...tab, system: true, focused: true })).toBeNull();
    // A focused tab that shows the thread has it on screen already.
    expect(presentationChannel({ ...tab, focused: true, viewing: true })).toBe("seen");
  });
});

describe("claimNeedsYouSubject", () => {
  it("lets one tab of a browser claim each subject, and remembers who presented what", () => {
    const storage = memoryStorage();
    expect(claimNeedsYouSubject(storage, "one", "run:r", 0)).toBe(true);
    expect(claimNeedsYouSubject(storage, "one", "run:r", 1_000)).toBe(false);
    expect(claimedNeedsYouSubject(storage, "one", "run:r", 1_000)).toBe(true);
    expect(claimedNeedsYouSubject(storage, "one", "run:other", 1_000)).toBe(false);
    // Each server has its own digest of the day, with its own count.
    expect(claimNeedsYouSubject(storage, "one", "digest:2026-11-19", 1_000)).toBe(true);
    expect(claimNeedsYouSubject(storage, "two", "digest:2026-11-19", 1_000)).toBe(true);
    expect(claimedNeedsYouSubject(storage, "two", "run:r", 1_000)).toBe(false);
    // Claims expire after two days, also before another claim prunes them.
    const later = 3 * 24 * 60 * 60_000;
    expect(claimedNeedsYouSubject(storage, "one", "run:r", later)).toBe(false);
    expect(claimNeedsYouSubject(storage, "one", "run:r", later)).toBe(true);
  });
});

describe("needsYouSource", () => {
  it("alerts from shells only where the server lacks the needs-you stream", () => {
    const lacking = AsyncResult.failure(
      Cause.die(`Unknown request tag: ${NEEDS_YOU_WS_METHODS.subscribe}`),
    );
    expect(needsYouSource(null, AsyncResult.initial())).toBeNull();
    expect(needsYouSource(null, lacking)).toBe("shells");
    // Other failures say nothing about the server's version.
    expect(needsYouSource(null, AsyncResult.failure(Cause.die("Unknown request tag: other")))).toBe(
      null,
    );
    expect(needsYouSource(null, AsyncResult.failure(Cause.fail("missing scope")))).toBeNull();
    // A server that streamed keeps the stream, whatever comes after.
    const streamed = needsYouSource(null, AsyncResult.success({ subjects: [] }));
    expect(streamed).toBe("stream");
    expect(needsYouSource(streamed, lacking)).toBe("stream");
  });
});

describe("shellAlerts", () => {
  const now = "2026-11-19T17:05:00.000Z";
  const asked = "2026-11-19T17:00:00.000Z";
  const thread = (id: string, needs: Record<string, unknown> = {}) =>
    ({
      id: ThreadId.make(id),
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      pendingSubagentRequest: null,
      pendingGuestMessageCount: 0,
      openAsks: [],
      latestRun: null,
      ...needs,
    }) as Parameters<typeof shellAlerts>[1][number];
  const question = { hasPendingUserInput: true, pendingUserInputAt: asked };
  const failed = (run: string) => ({
    latestRun: { runId: RunId.make(run), status: "failed", completedAt: now },
  });

  it("alerts what starts to need the user and failed runs, keyed by thread and need", () => {
    let seen: ShellAlertsSeen | null = null;
    const observe = (...threads: ReadonlyArray<ReturnType<typeof thread>>) => {
      const next = shellAlerts(seen, threads, now);
      seen = next.seen;
      return next.alerts.map(({ id, source, kind }) => [id, source, kind]);
    };
    // What the first look finds is history, and so is a thread's first sighting.
    expect(observe(thread("t", question))).toEqual([]);
    expect(observe(thread("t", question), thread("u", { hasPendingApprovals: true }))).toEqual([]);
    expect(observe(thread("t", question), thread("u"))).toEqual([]);
    expect(
      observe(
        thread("t", { ...question, hasPendingApprovals: true }),
        thread("u", {
          pendingGuestMessageCount: 1,
          source: { pendingGuestMessageAt: asked },
        }),
      ),
    ).toEqual([
      ["shell:t/approval:", "request", "approval"],
      ["shell:u/guest:2026-11-19T17:00:00.000Z", "guest", "input"],
    ]);
    // The approval answered, the question it came after does not alert again.
    expect(observe(thread("t", question), thread("u"))).toEqual([]);
    expect(observe(thread("t", { ...question, ...failed("r1") }), thread("u"))).toEqual([
      ["shell:t/failed:r1", "run", "failed"],
    ]);
    // Once a thread needs nothing, the same need alerts again.
    expect(observe(thread("t"), thread("u"))).toEqual([]);
    const next = shellAlerts(seen, [thread("t", question), thread("u")], now);
    expect(next.alerts.map(({ id }) => id)).toEqual(["shell:t/question:2026-11-19T17:00:00.000Z"]);
    expect([...next.open]).toEqual(["shell:t/question:2026-11-19T17:00:00.000Z"]);
  });
});
