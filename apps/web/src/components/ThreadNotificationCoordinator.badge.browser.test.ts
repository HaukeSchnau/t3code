import type { AnyRouter } from "@tanstack/react-router";
import {
  type EnvironmentThreadShell,
  presentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { EnvironmentId, type NeedsYouSubject, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { stubGlobal } from "../../test/render";

const state = vi.hoisted(() => ({
  mode: "notifications",
  inApp: false,
  toast: vi.fn(),
  shells: null as unknown as { set: (id: string, value: unknown) => void },
  navigate: vi.fn(),
  sound: vi.fn(),
  badge: vi.fn(),
  settingsListeners: new Set<() => void>(),
}));
vi.mock(import("./ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: state.toast as never } };
});
vi.mock(import("../state/shell"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentShell: {
      ...actual.environmentShell,
      stateValueAtom: ((id: string) => shellAtom(id)) as never,
    },
  };
});
vi.mock(import("../state/presentation"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentSummaries: {
      ...actual.environmentSummaries,
      // Read lazily: the factory runs before this module's own bindings exist.
      get environmentIdsAtom() {
        return environmentIdsAtom as never;
      },
    },
  };
});
vi.mock(import("../state/threads"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentThreadShells: {
      ...actual.environmentThreadShells,
      pendingSubagentRequestsAtom: (() => noRequestsAtom) as never,
      get delegatedUnderParentAtom() {
        return noDelegatedAtom as never;
      },
      get quietThreadShellsAtom() {
        return listedShellsAtom as never;
      },
    },
  };
});
vi.mock(import("../state/needsYou"), () => ({
  needsYouSubjectsAtom: ((target: { readonly environmentId: string }) =>
    subjectsAtom(target.environmentId)) as never,
}));
vi.mock(import("../hooks/useSettings"), async (original) => ({
  ...(await original()),
  subscribeClientSettings: ((listener: () => void) => {
    state.settingsListeners.add(listener);
    return () => state.settingsListeners.delete(listener);
  }) as never,
  getClientSettings: (() => ({
    notificationMode: state.mode,
    inAppNotificationsEnabled: state.inApp,
  })) as never,
}));
vi.mock(import("../threadNotifications"), async (original) => ({
  ...(await original()),
  playNotificationSound: state.sound,
  unlockNotificationAudio: vi.fn(),
  setNotificationBadge: state.badge,
}));

import { startThreadNotifications } from "./ThreadNotificationCoordinator";

let registry: AtomRegistry.AtomRegistry;
const shellAtom = Atom.family((_id: string) => Atom.make<unknown>(null));
const subjectsAtom = Atom.family((_id: string) =>
  Atom.make<AsyncResult.AsyncResult<{ readonly subjects: ReadonlyArray<NeedsYouSubject> }>>(
    AsyncResult.initial(),
  ),
);
const environmentIdsAtom = Atom.make<ReadonlyArray<string>>([]);
const noRequestsAtom = Atom.make(new Map());
const noDelegatedAtom = Atom.make<ReadonlySet<string>>(new Set<string>());
const listedShellsAtom = Atom.make<ReadonlyArray<EnvironmentThreadShell>>([]);
state.shells = { set: (id, value) => registry.set(shellAtom(id), value) };

class TestNotification extends EventTarget {
  static permission = "granted";
  static sent: TestNotification[] = [];
  /** The browser rejects the next one, as some do although they grant the permission. */
  static rejectNext = false;
  close = vi.fn();
  get tag() {
    return this.options.tag ?? "";
  }
  constructor(
    readonly title: string,
    readonly options: NotificationOptions,
  ) {
    super();
    if (TestNotification.rejectNext) {
      TestNotification.rejectNext = false;
      throw new TypeError("Illegal constructor");
    }
    TestNotification.sent.push(this);
  }
}

const thread = {
  id: "thread",
  title: "Test thread",
  archivedAt: null as string | null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  pendingRequestId: "request-1",
  session: null as { status: string } | null,
  latestTurn: { turnId: "turn", state: "running", completedAt: null as string | null },
  snoozedAt: null as string | null,
  snoozedUntil: null as string | null,
  // The asks the subjects below are about, open until a test answers them.
  openAsks: ["a", "turn_end:r", "r-one", "r-two"] as ReadonlyArray<string>,
};
let focused = false;
let visibility = "visible";

const SHELL_NOW = DateTime.makeUnsafe("2026-09-13T07:00:00.000Z");

function toV2ThreadShell(input: typeof thread) {
  const latestTurn = input.latestTurn;
  return {
    id: input.id,
    projectId: "project",
    title: input.title,
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: input.id,
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: latestTurn.turnId,
    activeRunId: null,
    status:
      latestTurn.state === "completed"
        ? "completed"
        : latestTurn.state === "error" || input.session?.status === "error"
          ? "failed"
          : "running",
    pendingRuntimeRequest: input.hasPendingUserInput
      ? { id: input.pendingRequestId, kind: "user_input", createdAt: SHELL_NOW }
      : input.hasPendingApprovals
        ? { id: input.pendingRequestId, kind: "command", createdAt: SHELL_NOW }
        : null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    openAsks: input.openAsks.map((id) => ({
      id,
      source: { type: "turn_end", runId: "turn" },
      text: "Pick one?",
      raisedAt: "2026-09-13T07:04:00.000Z",
    })),
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: SHELL_NOW,
    updatedAt: SHELL_NOW,
    latestRunRequestedAt: SHELL_NOW,
    latestRunStartedAt: SHELL_NOW,
    latestRunCompletedAt: latestTurn.completedAt
      ? DateTime.makeUnsafe(latestTurn.completedAt)
      : undefined,
    archivedAt: input.archivedAt ? DateTime.makeUnsafe(input.archivedAt) : null,
    snoozedAt: input.snoozedAt ? DateTime.makeUnsafe(input.snoozedAt) : null,
    snoozedUntil: input.snoozedUntil ? DateTime.makeUnsafe(input.snoozedUntil) : null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

function shell(overrides: Partial<typeof thread> = {}, ...others: Partial<typeof thread>[]) {
  return {
    status: "live",
    snapshot: Option.some({
      threads: [overrides, ...others].map((override) =>
        toV2ThreadShell({ ...thread, ...override }),
      ),
    }),
  };
}
/** Waits until every tab released the claims lock, so their presentations are done. */
async function claimsSettled() {
  await navigator.locks.request("t3code:needs-you-claims", () => undefined);
}

/** Holds the claims lock, as another tab does, until the returned function releases it. */
async function holdClaims() {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await new Promise<void>((granted) => {
    void navigator.locks.request("t3code:needs-you-claims", () => {
      granted();
      return released;
    });
  });
  return release;
}

const savedCursor = (environmentId: string) =>
  window.localStorage.getItem(`t3code:needs-you-cursor:${environmentId}`);

const PUBLISHED_AT = "2026-09-13T07:05:00.000Z";

const subject = (
  id: string,
  version: number,
  overrides: Partial<NeedsYouSubject> = {},
): NeedsYouSubject => ({
  id,
  version,
  source: "request",
  kind: "input",
  threadId: ThreadId.make("thread"),
  at: PUBLISHED_AT,
  publishedAt: PUBLISHED_AT,
  resolved: false,
  superseded: false,
  ...overrides,
});

/** The environment's subjects as its server streams them. */
function stream(environmentId: string, ...subjects: ReadonlyArray<NeedsYouSubject>) {
  registry.set(subjectsAtom(environmentId), AsyncResult.success({ subjects }));
}

/** The environment's subjects as its server streams them, then the presentations they cause. */
async function publish(environmentId: string, ...subjects: ReadonlyArray<NeedsYouSubject>) {
  stream(environmentId, ...subjects);
  await claimsSettled();
}

const titles = () => TestNotification.sent.map(({ title }) => title);

// The mocked modules read `state` and the focus flags, so every test resets them before
// starting the service.
function setup() {
  vi.clearAllMocks();
  const stack = new AsyncDisposableStack();
  registry = AtomRegistry.make();
  const testRegistry = registry;
  stack.defer(() => testRegistry.dispose());
  state.mode = "notifications";
  state.inApp = false;
  state.settingsListeners.clear();
  registry.set(environmentIdsAtom, ["one", "two"]);
  state.shells.set("one", shell());
  state.shells.set("two", shell());
  focused = false;
  visibility = "visible";
  TestNotification.permission = "granted";
  TestNotification.sent = [];
  TestNotification.rejectNext = false;
  window.localStorage.removeItem("t3code:needs-you-claims");
  // This browser watched both environments before, so what they publish now is new.
  for (const id of ["one", "two"])
    window.localStorage.setItem(`t3code:needs-you-cursor:${id}`, "0");
  // Alerts older than ten minutes are history; the shells below happen just before this.
  vi.setSystemTime(new Date("2026-09-13T07:06:00.000Z"));
  stack.defer(() => void vi.useRealTimers());
  stack.use(stubGlobal("Notification", TestNotification));
  stack.use(vi.spyOn(window, "focus").mockImplementation(() => undefined));
  stack.use(vi.spyOn(document, "hasFocus").mockImplementation(() => focused));
  stack.use(
    vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibility as DocumentVisibilityState),
  );
  const router = {
    state: { matches: [{ params: {} }] },
    navigate: state.navigate,
  } as unknown as AnyRouter;
  return {
    start: () => {
      stack.defer(startThreadNotifications(testRegistry, router));
    },
    setEnvironmentIds: (ids: ReadonlyArray<string>) => testRegistry.set(environmentIdsAtom, ids),
    changeSettings: () => {
      for (const listener of state.settingsListeners) listener();
    },
    [Symbol.asyncDispose]: () => stack.disposeAsync(),
  };
}

it.each([
  ["approval", "Approval needed"],
  ["input", "Input needed"],
] as const)(
  "presents a request for %s, opens it on click, and closes it when notifications are disabled",
  async (kind, title) => {
    await using app = setup();
    app.start();
    await publish("one", subject("request:q", 1, { kind }));
    const notification = TestNotification.sent[0]!;
    expect(notification.title).toBe(title);
    notification.dispatchEvent(new Event("click"));
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: EnvironmentId.make("one"), threadId: "thread" },
    });
    state.mode = "sound";
    app.changeSettings();
    expect(notification.close).toHaveBeenCalled();
  },
);

const listed = (id: string, flags: Partial<typeof thread>, waitingSince = SHELL_NOW) => {
  const raw = toV2ThreadShell({ ...thread, id, title: `Thread ${id}`, openAsks: [], ...flags });
  return presentThreadShell(EnvironmentId.make("one"), {
    ...raw,
    pendingRuntimeRequest: raw.pendingRuntimeRequest && {
      ...raw.pendingRuntimeRequest,
      createdAt: waitingSince,
    },
  } as never);
};

it("badges how many threads need you, through focus and notification modes", async () => {
  await using app = setup();
  app.start();
  expect(state.badge).toHaveBeenLastCalledWith(0);
  registry.set(listedShellsAtom, [
    listed("approval", { hasPendingApprovals: true }),
    listed("question", { hasPendingUserInput: true }),
    listed("working", {}),
  ]);
  expect(state.badge).toHaveBeenLastCalledWith(2);
  window.dispatchEvent(new Event("focus"));
  state.mode = "off";
  app.changeSettings();
  expect(state.badge).toHaveBeenLastCalledWith(2);
  registry.set(listedShellsAtom, [listed("question", { hasPendingUserInput: true })]);
  expect(state.badge.mock.calls).toEqual([[0], [2], [1]]);
});

it("presents each subject once per browser, across reconnects, a second tab and a reload", async () => {
  await using app = setup();
  app.start();
  await publish("one", subject("request:q", 1));
  // The stream sends its snapshot again after a reconnect.
  await publish("one", subject("request:q", 1));
  // A second tab finds the same snapshot.
  app.start();
  await claimsSettled();
  expect(titles()).toEqual(["Input needed"]);
  // A page loaded later resumes from the version this browser saw last.
  app.start();
  await publish(
    "one",
    subject("request:q", 1),
    subject("run:r", 2, { source: "run", kind: "completed" }),
  );
  expect(titles()).toEqual(["Input needed", "Thread completed"]);
});

it("treats what a first-time browser finds as history, then presents what comes after", async () => {
  await using app = setup();
  window.localStorage.removeItem("t3code:needs-you-cursor:one");
  app.start();
  await publish("one", subject("request:q", 1));
  expect(titles()).toEqual([]);
  await publish("one", subject("request:q", 1), subject("request:q2", 2));
  expect(titles()).toEqual(["Input needed"]);
});

it("an ask that replaces its run's completion takes its place without a second sound", async () => {
  await using app = setup();
  state.mode = "notifications-and-sound";
  app.start();
  const done = subject("run:r", 1, { source: "run", kind: "completed" });
  await publish("one", done);
  await publish(
    "one",
    done,
    subject("ask:turn_end:r", 2, { source: "ask", text: "Pick one?", replaces: "run:r" }),
  );
  expect(titles()).toEqual(["Thread completed", "Input needed"]);
  const [completion, ask] = TestNotification.sent;
  expect(ask!.tag).toBe(completion!.tag);
  expect(state.sound).toHaveBeenCalledTimes(1);
  expect(state.sound).toHaveBeenCalledWith("completion", expect.any(Function));
});

it("catching up, presents an ask in place of the Done it superseded, with its sound, or neither once it ended", async () => {
  await using app = setup();
  state.mode = "notifications-and-sound";
  app.start();
  const done = subject("run:r", 3, { source: "run", kind: "completed", superseded: true });
  const ask = subject("ask:turn_end:r", 2, { source: "ask", text: "Pick one?", replaces: "run:r" });
  await publish("one", ask, done);
  expect(titles()).toEqual(["Input needed"]);
  expect(state.sound.mock.calls).toEqual([["input", expect.any(Function)]]);
  // No reply needed before this browser caught up: it presents neither.
  await publish(
    "two",
    { ...done, threadId: ThreadId.make("thread") },
    subject("ask:turn_end:r", 4, { source: "ask", replaces: "run:r", resolved: true }),
  );
  expect(titles()).toEqual(["Input needed"]);
});

it("waits for a subject's thread to load, and an ask to open, before presenting it, and a reload starts before it", async () => {
  await using app = setup();
  state.shells.set("one", { status: "live", snapshot: Option.none() });
  app.start();
  await publish("one", subject("request:q", 1));
  expect(titles()).toEqual([]);
  expect(savedCursor("one")).toBe("0");
  state.shells.set("one", shell());
  await claimsSettled();
  expect(titles()).toEqual(["Input needed"]);
  expect(savedCursor("one")).toBe("1");
  // After a reconnect two snapshots queue behind another tab's claims. The first saves only the
  // versions it went through, not the second's, whose thread is not loaded yet.
  const release = await holdClaims();
  const loaded = subject("request:q2", 2);
  stream("one", subject("request:q", 1), loaded);
  const betweenSnapshots = navigator.locks.request("t3code:needs-you-claims", () =>
    savedCursor("one"),
  );
  stream(
    "one",
    subject("request:q", 1),
    loaded,
    subject("request:q3", 3, { threadId: ThreadId.make("other") }),
  );
  release();
  expect(await betweenSnapshots).toBe("2");
  await claimsSettled();
  expect(titles()).toEqual(["Input needed", "Input needed"]);
  expect(savedCursor("one")).toBe("2");
  state.shells.set("one", shell({}, { id: "other" }));
  await claimsSettled();
  expect(titles()).toEqual(["Input needed", "Input needed", "Input needed"]);
  expect(savedCursor("one")).toBe("3");
  // The shell shows an ask answered before the stream resolves it, or open only after its
  // subject came. Either way the ask waits until the shell shows it open.
  await publish("one", subject("ask:b", 4, { source: "ask" }));
  expect(titles()).toHaveLength(3);
  await publish("one", subject("ask:b", 5, { source: "ask", resolved: true }));
  expect(savedCursor("one")).toBe("5");
  await publish("one", subject("ask:c", 6, { source: "ask" }));
  expect(titles()).toHaveLength(3);
  state.shells.set("one", shell({ openAsks: ["c"] }, { id: "other" }));
  await claimsSettled();
  expect(titles()).toHaveLength(4);
  expect(savedCursor("one")).toBe("6");
});

it("presents a failure on a thread snoozed before it, also while a queued wake runs", async () => {
  await using app = setup();
  state.shells.set(
    "one",
    shell({ snoozedAt: "2026-09-13T07:04:00.000Z", snoozedUntil: "2026-09-13T09:00:00.000Z" }),
  );
  app.start();
  await publish(
    "one",
    subject("run:failed@1", 1, { source: "run", kind: "failed", at: "2026-09-13T07:05:00.000Z" }),
    // Anything else waits for the snooze to end.
    subject("request:q", 2),
  );
  expect(titles()).toEqual(["Thread failed"]);
});

it("presents nothing that was resolved, and closes what it presented once it is", async () => {
  await using app = setup();
  app.start();
  await publish("one", subject("request:q", 1));
  const notification = TestNotification.sent[0]!;
  await publish(
    "one",
    subject("request:q", 2, { resolved: true }),
    subject("ask:a", 3, { resolved: true }),
  );
  expect(notification.close).toHaveBeenCalled();
  expect(titles()).toEqual(["Input needed"]);
  // A subject waits for its thread, or behind another tab's claims, where its resolution, the
  // thread's load and a snapshot without it queue too: it stays unpresented. So it does when only
  // that snapshot leaves it out, as for an ask answered and cancelled in one go.
  for (const [environmentId, id, version, thread, resolves] of [
    ["one", "r-one", 4, "loads last", true],
    ["two", "r-two", 1, "loads first", true],
    ["two", "turn_end:r", 3, "loaded", true],
    ["one", "turn_end:r", 6, "loads first", false],
  ] as const) {
    const waiting = subject(`ask:${id}`, version, { source: "ask" });
    if (thread !== "loaded") {
      state.shells.set(environmentId, { status: "live", snapshot: Option.none() });
      await publish(environmentId, waiting);
    }
    const release = await holdClaims();
    if (thread === "loaded") stream(environmentId, waiting);
    if (thread === "loads first") state.shells.set(environmentId, shell());
    if (resolves) stream(environmentId, { ...waiting, version: version + 1, resolved: true });
    if (thread === "loads last") state.shells.set(environmentId, shell());
    stream(environmentId);
    release();
    await claimsSettled();
  }
  expect(titles()).toEqual(["Input needed"]);
});

it("archiving and unarchiving a thread presents nothing again, and an archived thread nothing", async () => {
  await using app = setup();
  app.start();
  const ask = subject("ask:a", 1, { source: "ask" });
  await publish("one", ask);
  state.shells.set("one", shell({ archivedAt: "2026-09-13T07:05:30.000Z" }));
  state.shells.set("one", shell());
  await publish("one", ask);
  expect(titles()).toEqual(["Input needed"]);
  state.shells.set("one", shell({ archivedAt: "2026-09-13T07:05:30.000Z" }));
  await publish("one", ask, subject("request:q", 2));
  expect(titles()).toEqual(["Input needed"]);
});

it("shows the digest as a system notification in a focused tab without toasts, in one tab", async () => {
  await using app = setup();
  focused = true;
  app.start();
  app.start();
  await publish(
    "one",
    subject("digest:2026-09-13", 1, {
      source: "digest",
      kind: "digest",
      text: "1 thread needs you",
    }),
  );
  expect(
    TestNotification.sent.map(({ title, tag, options }) => [title, tag, options.body]),
  ).toEqual([["1 thread needs you", "t3-needs-you-digest", "Waiting longest: Test thread"]]);
});

it("leaves a reminder, or an alert the browser would not show, to a tab that can present it, such as this one once focused, or a toast", async () => {
  await using app = setup();
  // A background tab with system notifications off and toasts on cannot present it.
  state.mode = "off";
  state.inApp = true;
  app.start();
  await publish("one", subject("remind:ask:a", 1, { source: "reminder", text: "Pick a?" }));
  expect(state.toast).not.toHaveBeenCalled();
  focused = true;
  window.dispatchEvent(new Event("focus"));
  await claimsSettled();
  expect(state.toast.mock.calls.map(([toast]) => [toast.title, toast.description])).toEqual([
    ["Still waiting for you", "Test thread: Pick a?"],
  ]);
  // A background tab claims an alert only once its system notification was shown.
  state.mode = "notifications";
  app.changeSettings();
  focused = false;
  TestNotification.rejectNext = true;
  await publish("one", subject("request:q", 2));
  expect(titles()).toEqual([]);
  focused = true;
  window.dispatchEvent(new Event("focus"));
  await claimsSettled();
  expect(state.toast.mock.calls.map(([toast]) => toast.title)).toEqual([
    "Still waiting for you",
    "Input needed",
  ]);
  // A focused tab shows a reminder as a toast when the browser would not show it as a system
  // notification.
  TestNotification.rejectNext = true;
  await publish("one", subject("remind:request:q", 3, { source: "reminder", text: "Question" }));
  expect(titles()).toEqual([]);
  expect(state.toast.mock.calls.map(([toast]) => toast.title)).toEqual([
    "Still waiting for you",
    "Input needed",
    "Still waiting for you",
  ]);
});
