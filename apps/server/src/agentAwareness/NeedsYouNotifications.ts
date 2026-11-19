import {
  askedRunId,
  CommandId,
  type EnvironmentId,
  type NeedsYouSubjectsSnapshot,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { turnItemUpdateCanEndBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { readRunEnd } from "../orchestration-v2/threadReturn.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { forkParked } from "../serverActivation.ts";
import * as LocalAgentAwareness from "./LocalAgentAwareness.ts";
import * as NeedsYouLedger from "./NeedsYouLedger.ts";
import {
  childNeedsYouRequests,
  DIGEST_LATE_MS,
  dueNeedsYouDigest,
  isTopLevel,
  NEEDS_YOU_ALERT_WINDOW_MS,
  needsYouThreads,
  reminderDueAt,
  requestOwner,
  subjectVerdict,
} from "./needsYouRules.ts";

const TICK_MS = 60_000;
/** The cursor moves with each recorded change, else at most this many events apart. */
const CURSOR_WRITE_EVERY = 1_000;
/** Run ends already handled, so the repeated updates of a finished run read nothing again. */
const HANDLED_END_LIMIT = 2_000;
/**
 * Start until the cursor is seeded (readiness waits for it); after a failed batch or stream,
 * read again from the cursor.
 */
const RETRY = Schedule.min([Schedule.exponential("1 second"), Schedule.spaced("1 minute")]);

type Shell = OrchestrationV2ThreadShell;

const millis = (value: string | DateTime.Utc) =>
  typeof value === "string" ? Date.parse(value) : DateTime.toEpochMillis(value);

type ThreadEvent = Extract<
  OrchestrationV2DomainEvent,
  { readonly payload: OrchestrationV2AppThread }
>;

/** Every thread event but a pull request link's carries the thread, with its asks. */
const carriesThread = (event: OrchestrationV2DomainEvent): event is ThreadEvent =>
  event.type.startsWith("thread.") && event.type !== "thread.pull-request-link-updated";

/** Whether the event can change what a thread needs, its count or a held completion. */
export function changesNeeds(event: OrchestrationV2DomainEvent): boolean {
  switch (event.type) {
    // Streaming text and bookkeeping that no need or count reads.
    case "message.updated":
    case "plan.updated":
    case "checkpoint-scope.created":
    case "checkpoint.captured":
    case "checkpoint.rollback-requested":
    case "context-handoff.updated":
    case "context-transfer.created":
    case "context-transfer.updated":
    case "provider-turn.updated":
    case "node.updated":
      return false;
    case "turn-item.updated":
      // Secret and link cards wait like questions; finished background work frees a completion.
      return (
        event.payload.type === "secret_request" ||
        event.payload.type === "link_request" ||
        turnItemUpdateCanEndBackgroundWork(event.payload)
      );
    default:
      return true;
  }
}

const REQUEST_LABELS = { approval: "Approval needed", input: "Question" } as const;
const PUSH_LABELS = {
  completed: "Done",
  failed: "Failed",
  approval: "Approval",
  input: "Input",
} as const;

export class NeedsYouNotifications extends Context.Service<
  NeedsYouNotifications,
  {
    /** Subjects published or resolved in the alert window, again on each change. */
    readonly subjects: Stream.Stream<NeedsYouSubjectsSnapshot>;
    /** Waits until events through `sequence` and the due work are recorded. */
    readonly recorded: (sequence: number) => Effect.Effect<void>;
    /** Waits until events through `sequence` are recorded and every delivery is done. */
    readonly settle: (sequence: number) => Effect.Effect<void>;
    readonly start: Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/agentAwareness/NeedsYouNotifications") {}

/**
 * Alerts come from committed events, read in order from a durable cursor: a run's end (a run the
 * user started, or a failure), an ask, a request, a guest's message, each recorded once as a
 * subject. Current state decides only the count, schedules (reminders, the digest), when held
 * work frees a completion, and whether a subject still alerts right before each delivery.
 */
export const make = Effect.gen(function* () {
  const awareness = yield* LocalAgentAwareness.LocalAgentAwareness;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const ledger = yield* NeedsYouLedger.NeedsYouLedger;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const nowMs = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
  // Every thread's current shell, for the count; kept under `serial` below.
  const shells = new Map<ThreadId, Shell>();
  // `<run id>@<epoch ms it ended>`: a failed run can run again under its id.
  const handledEnds = new Set<string>();
  const waitingThreads = new Set<ThreadId>();
  const processed = yield* SubscriptionRef.make(-1);
  // Event batches and the tick take turns.
  const serial = yield* Semaphore.make(1);
  let eventsSinceCursor = 0;
  // The cursor as the ledger holds it, where reading starts again after a failure.
  let committed = -1;
  // The first start: what began before it is history, also when a later event repeats it.
  let firstStart = 0;

  const logged = <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.catchCause((cause) => Effect.logWarning(label, { cause })));

  const readShell = (threadId: ThreadId) =>
    threads.getThreadShell(threadId).pipe(
      Effect.tap((shell) =>
        Effect.sync(() => {
          if (shell === null) shells.delete(threadId);
          else shells.set(threadId, shell);
        }),
      ),
    );

  const recount = Effect.gen(function* () {
    const now = yield* nowMs;
    const count = needsYouThreads(shells.values(), now).filter(
      (entry) => entry.need !== null && !entry.snoozed,
    ).length;
    yield* awareness.setNeedsYouCount(count);
  });

  /** Whether the need behind a subject (or a reminder's need) is still open where it lives. */
  const needOpen = Effect.fn("NeedsYouNotifications.needOpen")(function* (
    subject: Pick<NeedsYouLedger.NewSubject, "id" | "sourceThreadId">,
    shell: Shell,
  ) {
    const needId = subject.id.startsWith("remind:") ? subject.id.slice(7) : subject.id;
    if (needId.startsWith("ask:")) {
      return (shell.openAsks ?? []).some((ask) => `ask:${ask.id}` === needId);
    }
    if (needId.startsWith("guest:")) {
      if ((shell.pendingGuestMessageCount ?? 0) === 0) return false;
      const { thread } = yield* threads.getThreadRecords(subject.sourceThreadId, []);
      return (thread.guestShare?.messages ?? []).some(
        (message) => `guest:${message.id}` === needId && message.status === "pending",
      );
    }
    if (!needId.startsWith("request:")) return true;
    const requestId = needId.slice(8);
    const records = yield* threads.getThreadRecords(
      subject.sourceThreadId,
      ["runtimeRequests", "turnItems"],
      {
        runtimeRequestStatuses: ["pending"],
        turnItemTypes: ["secret_request", "link_request"],
        turnItemStatuses: ["waiting"],
      },
    );
    if (records.runtimeRequests.some((request) => request.id === requestId)) return true;
    const card = records.turnItems.find((item) => item.id === requestId);
    if (card === undefined) return false;
    // As in the shell: the agent waits for a secret in its run, which must still be live.
    if (card.type === "secret_request") {
      if (card.runId === null) return false;
      const { runs } = yield* threads.getThreadRecords(subject.sourceThreadId, ["runs"], {
        runIds: [card.runId],
      });
      return runs.some((run) => run.id === card.runId && ThreadManagement.isActiveRun(run));
    }
    // A link card stops waiting once the user writes in its thread again.
    const source = subject.sourceThreadId === shell.id ? shell : shells.get(subject.sourceThreadId);
    const wrote = source?.latestUserAuthoredMessageAt;
    return wrote == null || millis(wrote) <= millis(card.startedAt ?? card.updatedAt);
  });

  /** What current state says about a subject, for `subjectVerdict`. */
  const verdictOf = Effect.fn("NeedsYouNotifications.verdictOf")(function* (
    subject: NeedsYouLedger.NewSubject &
      Partial<Pick<NeedsYouLedger.StoredSubject, "heldUntil" | "state" | "superseded">>,
    knownShell?: Shell | null,
  ) {
    const now = yield* nowMs;
    const shell = knownShell === undefined ? yield* readShell(subject.threadId) : knownShell;
    if (shell === null) return { verdict: "drop" as const, shell, superseded: false };
    if (subject.source === "digest") return { verdict: "alert" as const, shell, superseded: false };
    // An ask for the run, in any state, took the place of its completion; a failure stays.
    const runId =
      subject.source === "run" && subject.kind === "completed"
        ? subject.id.slice("run:".length)
        : null;
    const superseded =
      runId !== null &&
      (subject.superseded === true ||
        ((yield* threads.getThreadRecords(shell.id, [])).thread.asks ?? []).some(
          (ask) => askedRunId(ask) === runId,
        ));
    const childWaits =
      subject.sourceThreadId !== shell.id ||
      ((subject.source === "run" || shell.snoozedUntil != null) &&
        childNeedsYouRequests(shells.values()).has(shell.id));
    const verdict = subjectVerdict(
      { ...subject, waiting: subject.state === "waiting" },
      { shell, needOpen: yield* needOpen(subject, shell), superseded, childWaits },
      now,
    );
    return { verdict, shell, superseded };
  });

  /** The decision to record: published to the devices that want it, held, or dropped. */
  const decide = Effect.fn("NeedsYouNotifications.decide")(function* (
    subject: NeedsYouLedger.NewSubject &
      Partial<Pick<NeedsYouLedger.StoredSubject, "heldUntil" | "state">>,
    knownShell?: Shell | null,
  ) {
    const { verdict, shell, superseded } = yield* verdictOf(subject, knownShell);
    if (verdict === "hold") return { state: "waiting" } as const;
    if (verdict === "drop") return { state: "dropped", superseded } as const;
    // Tasks delegated from another environment alert on web only; the phone counts this server's.
    const tokens =
      shell === null || isTopLevel(shell) ? yield* awareness.alertTargets(subject.kind) : [];
    return { state: "published", tokens } as const;
  });

  // The orchestrator checks the run again; the command id makes a repeat a no-op. A failure fails
  // the batch, which is read again.
  const stampReturn = (entry: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly end: string;
  }) =>
    threads
      .dispatch({
        type: "thread.return",
        commandId: CommandId.make(`thread-return:${entry.end}`),
        threadId: entry.threadId,
        runId: entry.runId,
      })
      .pipe(Effect.asVoid);

  /** The subjects, resolutions and checks one batch of committed events calls for. */
  const derive = Effect.fn("NeedsYouNotifications.derive")(function* (
    events: ReadonlyArray<OrchestrationV2StoredEvent>,
    shellOf: (threadId: ThreadId) => ReturnType<typeof readShell>,
  ) {
    const subjects = new Map<string, NeedsYouLedger.NewSubject>();
    const resolve = new Set<string>();
    const supersede = new Set<string>();
    // When each ask in `subjects` was seen open again after it last ended, for one that reopens.
    const openSeenAt = new Map<string, number>();
    // Asks that ended and opened again within this batch, such as an answer and its cancellation.
    const ended = new Set<string>();
    const reopened = new Set<string>();
    const checks: Array<NeedsYouLedger.NeedsYouCheck & { readonly endedAt: number }> = [];
    const returns: Array<{
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly end: string;
    }> = [];
    const ends: Array<string> = [];
    const owners = new Map<ThreadId, Shell>();
    const ownerOf = Effect.fn("NeedsYouNotifications.ownerOf")(function* (
      threadId: ThreadId,
      kind: "approval" | "input",
    ) {
      const thread = yield* shellOf(threadId);
      if (thread === null) return null;
      // Read the ancestors a child's request may reach.
      let parentId = thread.lineage.parentThreadId;
      for (let hop = 0; parentId !== null && hop < 16 && !owners.has(parentId); hop += 1) {
        const parent = yield* shellOf(parentId);
        if (parent === null) break;
        owners.set(parent.id, parent);
        parentId = parent.lineage.parentThreadId;
      }
      return requestOwner(thread, kind, (id) => owners.get(id));
    });
    // What started before the first start is history: a deploy alerts nothing from before it.
    const add = (subject: NeedsYouLedger.NewSubject) => {
      if (subject.at < firstStart) return;
      resolve.delete(subject.id);
      subjects.set(subject.id, subject);
    };
    const end = (id: string) => {
      subjects.delete(id);
      openSeenAt.delete(id);
      ended.add(id);
      resolve.add(id);
    };
    for (const { event } of events) {
      const threadId = event.threadId;
      if (carriesThread(event)) {
        const thread = event.payload;
        if (!isTopLevel(thread)) continue;
        // Asks end with any thread change, such as settling, not only with their own event.
        for (const ask of thread.asks ?? []) {
          const id = `ask:${ask.id}`;
          const run = askedRunId(ask);
          if (run !== undefined) supersede.add(`run:${run}`);
          if (ask.status !== "open") {
            end(id);
            continue;
          }
          add({
            id,
            source: "ask",
            kind: "input",
            threadId,
            sourceThreadId: threadId,
            at: Date.parse(ask.raisedAt),
            text: ask.text,
            replaces: ask.source.type === "turn_end" ? `run:${ask.source.runId}` : undefined,
          });
          if (!openSeenAt.has(id)) openSeenAt.set(id, DateTime.toEpochMillis(event.occurredAt));
          if (ended.has(id)) reopened.add(id);
        }
        if (event.type !== "thread.guest-share-updated") continue;
        for (const message of thread.guestShare?.messages ?? []) {
          const id = `guest:${message.id}`;
          if (message.status !== "pending") {
            end(id);
            continue;
          }
          add({
            id,
            source: "guest",
            kind: "input",
            threadId,
            sourceThreadId: threadId,
            at: Date.parse(message.submittedAt),
          });
        }
        continue;
      }
      switch (event.type) {
        case "run.updated": {
          const run = event.payload;
          if (run.status !== "completed" && run.status !== "failed") break;
          if (run.completedAt === null) break;
          const at = millis(run.completedAt);
          // A run whose workspace preparation failed runs again under its id: each end is its
          // own, and the repeated updates of one end are not.
          const runEnd = `${run.id}@${at}`;
          if (at < firstStart || handledEnds.has(runEnd)) break;
          const shell = yield* shellOf(threadId);
          if (shell === null || !isTopLevel(shell)) break;
          const ended = yield* readRunEnd(threads.getThreadRecords, threadId, run.id);
          if (ended === null) break;
          ends.push(runEnd);
          if (run.status === "completed") checks.push({ runId: run.id, threadId, endedAt: at });
          if (run.status === "failed" || (ended.startedByUser && !ended.stopRequested)) {
            add({
              id: run.status === "completed" ? `run:${run.id}` : `run:${runEnd}`,
              source: "run",
              kind: run.status,
              threadId,
              sourceThreadId: threadId,
              at,
            });
            returns.push({ threadId, runId: run.id, end: runEnd });
          }
          break;
        }
        case "runtime-request.updated": {
          const request = event.payload;
          if (request.kind === "auth_refresh") break;
          const id = `request:${request.id}`;
          if (request.status !== "pending") {
            end(id);
            break;
          }
          const kind = request.kind === "user_input" ? "input" : "approval";
          const owner = yield* ownerOf(threadId, kind);
          if (owner === null) break;
          add({
            id,
            source: "request",
            kind,
            threadId: owner.id,
            sourceThreadId: threadId,
            at: millis(request.createdAt),
          });
          break;
        }
        case "turn-item.updated": {
          const item = event.payload;
          if (item.type !== "secret_request" && item.type !== "link_request") break;
          const id = `request:${item.id}`;
          if (item.status !== "waiting") {
            end(id);
            break;
          }
          if (item.nodeId === null) break;
          const owner = yield* ownerOf(threadId, "input");
          if (owner === null) break;
          add({
            id,
            source: "request",
            kind: "input",
            threadId: owner.id,
            sourceThreadId: threadId,
            at: millis(item.startedAt ?? item.updatedAt),
          });
          break;
        }
        default:
          break;
      }
    }
    return {
      subjects: [...subjects.values()],
      resolve: [...resolve],
      supersede: [...supersede],
      openSeenAt,
      reopened,
      checks,
      returns,
      ends,
    };
  });

  /** Waiting subjects that current state now frees or drops; a hold is stamped on the tick. */
  const decideWaiting = Effect.fn("NeedsYouNotifications.decideWaiting")(function* (
    stampHolds: boolean,
  ) {
    waitingThreads.clear();
    for (const subject of yield* ledger.waiting) {
      const decision = yield* decide(subject);
      if (decision.state === "waiting") {
        waitingThreads.add(subject.threadId);
        if (stampHolds) yield* ledger.decideWaiting(subject.id, { state: "held" });
      } else {
        yield* ledger.decideWaiting(subject.id, decision);
      }
    }
  });

  const processEvents = Effect.fn("NeedsYouNotifications.processEvents")(function* (
    events: ReadonlyArray<OrchestrationV2StoredEvent>,
  ) {
    const last = events.at(-1);
    if (last === undefined) return;
    // Current shells, read once per batch: decisions and the count use the same state.
    const batch = new Map<ThreadId, Shell | null>();
    const shellOf = (threadId: ThreadId) =>
      batch.has(threadId)
        ? Effect.succeed(batch.get(threadId) ?? null)
        : readShell(threadId).pipe(
            Effect.tap((shell) => Effect.sync(() => batch.set(threadId, shell))),
          );
    const changed = new Set<ThreadId>();
    for (const { event } of events) if (changesNeeds(event)) changed.add(event.threadId);
    yield* Effect.forEach(changed, shellOf, { discard: true });
    const derived = yield* derive(events, shellOf);
    // The count goes out before the alerts, which carry it.
    if (changed.size > 0) yield* recount;
    // Before the cursor passes the run; the command id makes a repeat after a crash a no-op. A
    // failed stamp fails the batch, which is read again.
    yield* Effect.forEach(derived.returns, stampReturn, { discard: true });
    // Every thread event repeats its asks: only what changes the ledger is written.
    const known = yield* ledger.known([
      ...derived.subjects.map((subject) => subject.id),
      ...derived.resolve,
      ...derived.supersede,
    ]);
    const decided = yield* Effect.forEach(
      derived.subjects.filter((subject) => !known.has(subject.id)),
      (subject) =>
        decide(subject, batch.get(subject.threadId)).pipe(
          Effect.map((decision) => ({ subject, decision })),
        ),
    );
    const supersede = [
      ...derived.supersede.filter((id) => known.get(id)?.superseded === false),
      // A completion whose ask came before it, such as a page's dismissed before the run ended.
      ...decided.flatMap(({ subject, decision }) =>
        decision.state === "dropped" && decision.superseded ? [subject.id] : [],
      ),
    ];
    const resolve = derived.resolve.filter((id) => {
      const state = known.get(id)?.state;
      return state !== undefined && state !== "resolved";
    });
    // An ask whose answer was a queued reply the user cancelled is open again, also when the
    // answer and the cancellation came in this one batch: it reminds an hour from then. One
    // raised in this batch too is recorded below, and the reopen moves its time.
    const reopen = derived.subjects.flatMap((subject) => {
      const state = known.get(subject.id)?.state;
      return subject.source === "ask" && (state === "resolved" || derived.reopened.has(subject.id))
        ? [{ id: subject.id, at: derived.openSeenAt.get(subject.id) ?? subject.at }]
        : [];
    });
    eventsSinceCursor += events.length;
    const relevant =
      decided.length > 0 ||
      resolve.length > 0 ||
      supersede.length > 0 ||
      reopen.length > 0 ||
      derived.checks.length > 0;
    // Streaming text writes nothing; a restart reads those events again, which records nothing.
    if (relevant || eventsSinceCursor >= CURSOR_WRITE_EVERY) {
      yield* ledger.record({
        cursor: last.sequence,
        subjects: decided,
        supersede,
        resolve,
        reopen,
        checks: derived.checks,
      });
      eventsSinceCursor = 0;
      committed = last.sequence;
    }
    for (const runEnd of derived.ends) {
      handledEnds.add(runEnd);
      if (handledEnds.size > HANDLED_END_LIMIT) {
        handledEnds.delete(handledEnds.values().next().value!);
      }
    }
    for (const { subject, decision } of decided) {
      if (decision.state === "waiting") waitingThreads.add(subject.threadId);
    }
    // Recorded already: the tick decides again what this misses.
    if ([...changed].some((threadId) => waitingThreads.has(threadId))) {
      yield* logged("needs-you held completions failed", decideWaiting(false));
    }
    yield* requestDelivery;
    // Reading again after a failure goes back to the cursor; what was recorded stays recorded.
    yield* SubscriptionRef.update(processed, (through) => Math.max(through, last.sequence));
  });

  /** Reminders that came due, from current state. */
  const recordReminders = Effect.fn("NeedsYouNotifications.recordReminders")(function* (
    now: number,
  ) {
    const needs = yield* ledger.unremindedNeeds;
    const due: Array<{ readonly subject: NeedsYouLedger.NewSubject; readonly shell: Shell }> = [];
    for (const need of needs) {
      const cached = shells.get(need.threadId);
      if (cached === undefined || reminderDueAt(need.at, cached) > now) continue;
      // A snooze the events have not brought yet defers it, unrecorded, to a later tick.
      const shell = yield* readShell(need.threadId);
      if (shell === null) continue;
      const dueAt = reminderDueAt(need.at, shell);
      if (dueAt > now) continue;
      const subject: NeedsYouLedger.NewSubject = {
        id: `remind:${need.id}`,
        source: "reminder",
        kind: need.kind,
        threadId: need.threadId,
        sourceThreadId: need.sourceThreadId,
        at: dueAt,
        text:
          need.source === "ask"
            ? (need.text ?? "Input")
            : need.source === "guest"
              ? "Guest message"
              : REQUEST_LABELS[need.kind === "approval" ? "approval" : "input"],
      };
      due.push({ subject, shell });
    }
    const decided = yield* Effect.forEach(due, ({ subject, shell }) =>
      decide(subject, shell).pipe(Effect.map((decision) => ({ subject, decision }))),
    );
    yield* ledger.record({ subjects: decided, resolve: [], checks: [] });
  });

  /** Today's digest once it is due, if anything needs the user. */
  const recordDigest = Effect.fn("NeedsYouNotifications.recordDigest")(function* (now: number) {
    const due = dueNeedsYouDigest(now);
    if (due === null || now - due.dueAt > DIGEST_LATE_MS || (yield* ledger.has(due.id))) return;
    const waiting = needsYouThreads(shells.values(), now).filter(
      (entry) => entry.need !== null && !entry.snoozed,
    );
    const oldest = waiting.reduce<(typeof waiting)[number] | null>(
      (current, entry) =>
        current === null || (entry.need?.since ?? Infinity) < (current.need?.since ?? Infinity)
          ? entry
          : current,
      null,
    );
    if (oldest === null) return;
    yield* ledger.record({
      subjects: [
        {
          subject: {
            id: due.id,
            source: "digest",
            kind: "digest",
            threadId: oldest.shell.id,
            sourceThreadId: oldest.shell.id,
            at: due.dueAt,
            text:
              waiting.length === 1 ? "1 thread needs you" : `${waiting.length} threads need you`,
          },
          decision: { state: "published", tokens: yield* awareness.alertTargets("digest") },
        },
      ],
      resolve: [],
      checks: [],
    });
  });

  // Snoozes end, held work ends without an event (a closed watch), reminders and the digest come
  // due, and failed deliveries are due again.
  const tick = Effect.gen(function* () {
    const now = yield* nowMs;
    yield* recount;
    yield* decideWaiting(true);
    yield* recordReminders(now);
    yield* recordDigest(now);
    yield* requestDelivery;
  });

  const projectTitle = (projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      Effect.map(Option.match({ onNone: () => "", onSome: (project) => project.title })),
      Effect.orElseSucceed(() => ""),
    );

  const pushFor = Effect.fn("NeedsYouNotifications.pushFor")(function* (
    subject: NeedsYouLedger.StoredSubject,
    shell: Shell,
    environmentId: EnvironmentId,
  ): Effect.fn.Return<LocalAgentAwareness.NeedsYouPush> {
    const project = yield* projectTitle(shell.projectId);
    const base = {
      title: shell.title,
      environmentId,
      threadId: shell.id,
      deepLink: `/threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(shell.id)}`,
      kind: subject.kind,
      collapseKey: subject.replaces ?? subject.id,
    };
    switch (subject.source) {
      case "ask":
        return { ...base, body: subject.text ?? "Input" };
      case "guest":
        return { ...base, body: `Guest message: ${project}` };
      case "reminder":
        return { ...base, body: `Still waiting: ${subject.text ?? ""}` };
      case "digest":
        return {
          ...base,
          title: subject.text ?? "Threads need you",
          body: `Waiting longest: ${shell.title}`,
          // Today's digest replaces yesterday's.
          collapseKey: "digest",
        };
      case "run":
      case "request":
        return {
          ...base,
          body: `${subject.kind === "digest" ? "" : PUSH_LABELS[subject.kind]}: ${project}`,
        };
    }
  });

  /**
   * One delivery at a time, each decided under the lock badge and Live Activity requests take,
   * right before it goes out. Without an APNs answer it goes out again a minute later: a missed
   * "your turn" costs more than a second buzz, and the collapse id folds the copies.
   */
  const deliverOpen = Effect.fn("NeedsYouNotifications.deliverOpen")(function* () {
    const environmentId = yield* serverEnvironment.getEnvironmentId;
    while (true) {
      const next = yield* ledger.nextDelivery((yield* nowMs) - NEEDS_YOU_ALERT_WINDOW_MS);
      if (next === null) return;
      const key = { subjectId: next.subject.id, token: next.token };
      const prepare = Effect.gen(function* () {
        // Resolved, superseded or cancelled since it was picked.
        const delivery = yield* ledger.openDelivery(key);
        if (delivery === null) return null;
        const { subject } = delivery;
        // A published completion stays published if background work starts again.
        const { verdict, shell } = yield* verdictOf({ ...subject, heldUntil: subject.publishedAt });
        if (verdict === "drop" || shell === null) return null;
        const silent =
          subject.replaces !== undefined && (yield* ledger.accepted(subject.replaces, next.token));
        return { push: yield* pushFor(subject, shell, environmentId), silent };
      });
      yield* ledger.settle(key, yield* awareness.deliverAlert({ token: next.token, prepare }));
    }
  });

  // One fiber delivers; a request during a run asks for one more run.
  let deliveryRequested = false;
  const deliveries = yield* makeDrainableWorker((_: void) =>
    Effect.suspend(() => {
      deliveryRequested = false;
      return logged("needs-you delivery failed", deliverOpen());
    }),
  );
  const requestDelivery = Effect.suspend(() => {
    if (deliveryRequested) return Effect.void;
    deliveryRequested = true;
    return deliveries.enqueue(undefined);
  });

  /** Loads or seeds the cursor and the shells; retried until it succeeds. */
  const initialize = Effect.gen(function* () {
    // Read before the snapshot, so nothing after the snapshot counts as history.
    const startedAt = yield* nowMs;
    const snapshot = yield* threads.getShellSnapshot();
    const seeded = yield* ledger.seedCursor({ sequence: snapshot.snapshotSequence, startedAt });
    firstStart = seeded.startedAt;
    committed = seeded.sequence;
    shells.clear();
    for (const shell of snapshot.threads) shells.set(shell.id, shell);
    yield* recount;
    // A completion still held after an outage keeps waiting; this is when it was last seen held.
    yield* decideWaiting(true);
    yield* SubscriptionRef.set(processed, seeded.sequence);
  });

  const subjects: NeedsYouNotifications["Service"]["subjects"] = Stream.unwrap(
    Effect.gen(function* () {
      yield* ledger.ready;
      const changes = yield* PubSub.subscribe(ledger.changes);
      return Stream.concat(Stream.succeed(undefined), Stream.fromSubscription(changes)).pipe(
        Stream.mapEffect(() =>
          nowMs.pipe(
            Effect.flatMap((now) => ledger.recent(now - NEEDS_YOU_ALERT_WINDOW_MS)),
            Effect.map((recent) => ({ subjects: recent })),
            // Never sent as no subjects: the change that signalled it may be the last one before
            // its alert expires.
            Effect.tapError((cause) =>
              Effect.logWarning("needs-you subjects read failed", { cause }),
            ),
            Effect.retry(RETRY),
            Effect.orDie,
          ),
        ),
      );
    }),
  );

  /**
   * Reads committed events from the cursor, one batch at a time. A batch that fails stops the
   * stream before anything after it is recorded; reading starts again from the cursor, so no
   * batch is ever skipped, and the tick keeps running meanwhile.
   */
  const consume = Effect.suspend(() => {
    eventsSinceCursor = 0;
    return Stream.runForEachArray(threads.streamDomainEventsAfter(committed), (events) =>
      serial.withPermit(processEvents(events)),
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("needs-you events failed; reading again from the cursor", {
            cause,
          }).pipe(Effect.andThen(Effect.fail(cause))),
    ),
    Effect.retry(RETRY),
  );

  const ticks = Effect.forever(
    Effect.sleep(TICK_MS).pipe(
      Effect.andThen(serial.withPermit(logged("needs-you tick failed", tick))),
    ),
  );

  const recorded = Effect.fn("NeedsYouNotifications.recorded")(function* (sequence: number) {
    yield* SubscriptionRef.changes(processed).pipe(
      Stream.takeUntil((through) => through >= sequence),
      Stream.runDrain,
    );
    // A tick under way finishes first.
    yield* serial.withPermit(Effect.void);
  });

  return NeedsYouNotifications.of({
    subjects,
    recorded,
    settle: Effect.fn("NeedsYouNotifications.settle")(function* (sequence: number) {
      yield* recorded(sequence);
      yield* deliveries.drain;
    }),
    start: forkParked(
      Effect.gen(function* () {
        yield* initialize.pipe(
          Effect.tapError((cause) => Effect.logWarning("needs-you start failed", { cause })),
          Effect.retry(RETRY),
        );
        yield* ledger.markReady;
        yield* requestDelivery;
        yield* Effect.all([consume, ticks], { concurrency: "unbounded", discard: true });
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("needs-you stopped", { cause }))),
    ),
  });
});

export const layer = Layer.effect(
  NeedsYouNotifications,
  make.pipe(Effect.tap((notifications) => notifications.start)),
);
