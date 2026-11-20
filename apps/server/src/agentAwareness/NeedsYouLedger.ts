import type {
  NeedsYouSubject,
  NeedsYouSubjectKind,
  NeedsYouSubjectSource,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import type * as SqlError from "effect/sql/SqlError";
import * as SqlClient from "effect/sql/SqlClient";

/** Subjects and checks unchanged for this long are dropped at start, but for needs still open. */
const RETENTION_MS = 30 * 24 * 60 * 60_000;
/** A delivery that failed is tried again after this. */
const RETRY_AFTER_MS = 60_000;

export interface NewSubject {
  readonly id: string;
  readonly source: NeedsYouSubjectSource;
  readonly kind: NeedsYouSubjectKind;
  readonly threadId: ThreadId;
  /** Where the need lives, such as a subagent's thread for a request on its parent. */
  readonly sourceThreadId: ThreadId;
  readonly at: number;
  readonly text?: string | undefined;
  readonly replaces?: string | undefined;
}

export type SubjectState =
  /** Recorded, waiting for background work to free it (a completion). */
  | "waiting"
  /** Alerts: every client presents it, each device that wants it has a delivery. */
  | "published"
  /**
   * Does not alert: covered, stale, archived or snoozed when it was decided, or an ask that opened
   * again after it ended (it still reminds).
   */
  | "dropped"
  /** The need ended. */
  | "resolved";

export interface StoredSubject extends NewSubject {
  readonly state: SubjectState;
  readonly heldUntil: number | null;
  /** A completion whose run has an ask, which takes its place for good. */
  readonly superseded: boolean;
}

/** What to do with a subject now, decided from current state. */
export type SubjectDecision =
  | { readonly state: "published"; readonly tokens: ReadonlyArray<string> }
  | { readonly state: "waiting" }
  | { readonly state: "dropped" };

/** What became of one attempt to deliver an alert to a device. */
export type NeedsYouDeliveryOutcome =
  /** APNs accepted it. */
  | "accepted"
  /** No answer, or one worth trying again: tried again a minute later, within the window. */
  | "failed"
  /** APNs refused it for good, such as for an unregistered token. */
  | "rejected"
  /** The device, its token or its wish for this kind of alert is gone. */
  | "gone";

export interface NeedsYouDelivery {
  readonly subject: StoredSubject & { readonly publishedAt: number };
  readonly token: string;
}

export interface NeedsYouCheck {
  readonly runId: RunId;
  readonly threadId: ThreadId;
}

/**
 * The durable side of needs-you alerts: the event cursor, the subjects recorded from committed
 * events and schedules, each device's delivery of each published subject, and the completed runs
 * the turn-end detector still has to read (`needs_you_checks`).
 */
export class NeedsYouLedger extends Context.Service<
  NeedsYouLedger,
  {
    /**
     * On the first start, starts the cursor at `sequence` and keeps `startedAt`, before which
     * everything is history. Returns the cursor, the event sequence everything up to which is
     * recorded, and that first start.
     */
    readonly seedCursor: (input: {
      readonly sequence: number;
      readonly startedAt: number;
    }) => Effect.Effect<
      { readonly sequence: number; readonly startedAt: number },
      SqlError.SqlError
    >;
    /** Resolves once the cursor is loaded, so the detector and clients read recorded state. */
    readonly ready: Effect.Effect<void>;
    readonly markReady: Effect.Effect<void>;
    /** The ids among these that are already recorded, with their state. */
    readonly known: (
      ids: ReadonlyArray<string>,
    ) => Effect.Effect<
      ReadonlyMap<string, Pick<StoredSubject, "state" | "superseded">>,
      SqlError.SqlError
    >;
    /**
     * Records new subjects as decided, marks completions superseded, ends resolved subjects (and
     * their reminders), cancelling the open deliveries of both, opens resolved asks again, adds
     * checks and moves the cursor, in one transaction.
     */
    readonly record: (input: {
      readonly cursor?: number | undefined;
      readonly subjects: ReadonlyArray<{
        readonly subject: NewSubject;
        readonly decision: SubjectDecision;
      }>;
      /** Completion subjects (`run:<id>`) an ask now takes the place of. */
      readonly supersede?: ReadonlyArray<string> | undefined;
      readonly resolve: ReadonlyArray<string>;
      /** Asks open again after they ended, from `at` on, also ones `subjects` records. */
      readonly reopen?: ReadonlyArray<{ readonly id: string; readonly at: number }> | undefined;
      readonly checks: ReadonlyArray<NeedsYouCheck & { readonly endedAt: number }>;
    }) => Effect.Effect<void, SqlError.SqlError>;
    /** Subjects waiting for background work to free them. */
    readonly waiting: Effect.Effect<ReadonlyArray<StoredSubject>, SqlError.SqlError>;
    /** Decides a waiting subject; a hold stamps when it was last seen held. */
    readonly decideWaiting: (
      id: string,
      decision: SubjectDecision | { readonly state: "held" },
    ) => Effect.Effect<void, SqlError.SqlError>;
    /** Needs (asks, requests, guests' messages) not resolved and not reminded. */
    readonly unremindedNeeds: Effect.Effect<ReadonlyArray<StoredSubject>, SqlError.SqlError>;
    readonly has: (id: string) => Effect.Effect<boolean, SqlError.SqlError>;
    /** Whether this device's APNs accepted the subject. */
    readonly accepted: (id: string, token: string) => Effect.Effect<boolean, SqlError.SqlError>;
    /** The next delivery to try: pending, or failed a minute ago, of a subject published since. */
    readonly nextDelivery: (
      publishedSince: number,
    ) => Effect.Effect<NeedsYouDelivery | null, SqlError.SqlError>;
    /** The delivery as it stands now, while it is still to be sent. */
    readonly openDelivery: (
      delivery: Pick<NeedsYouDelivery, "token"> & { readonly subjectId: string },
    ) => Effect.Effect<NeedsYouDelivery | null, SqlError.SqlError>;
    readonly settle: (
      delivery: Pick<NeedsYouDelivery, "token"> & { readonly subjectId: string },
      outcome: NeedsYouDeliveryOutcome | "cancelled",
    ) => Effect.Effect<void, SqlError.SqlError>;
    /** Subjects published or resolved since, for clients. */
    readonly recent: (
      since: number,
    ) => Effect.Effect<ReadonlyArray<NeedsYouSubject>, SqlError.SqlError>;
    /** Signals each commit that published or resolved a subject. */
    readonly changes: PubSub.PubSub<void>;
    /** Completed runs not read yet, ended since. */
    readonly pendingChecks: (
      since: number,
    ) => Effect.Effect<ReadonlyArray<NeedsYouCheck>, SqlError.SqlError>;
    readonly isChecked: (runId: RunId) => Effect.Effect<boolean, SqlError.SqlError>;
    readonly markChecked: (runId: RunId) => Effect.Effect<void, SqlError.SqlError>;
    /** Checks added after this process started, as they commit. */
    readonly checksAdded: PubSub.PubSub<NeedsYouCheck>;
  }
>()("t3/agentAwareness/NeedsYouLedger") {}

interface SubjectRow {
  readonly id: string;
  readonly source: NeedsYouSubjectSource;
  readonly kind: NeedsYouSubjectKind;
  readonly thread_id: string;
  readonly source_thread_id: string;
  readonly at: string;
  readonly text: string | null;
  readonly replaces: string | null;
  readonly state: SubjectState;
  readonly superseded: number;
  readonly held_until: string | null;
  readonly version: number | null;
  readonly changed_at: string;
}

const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

const storedSubject = (row: SubjectRow): StoredSubject => ({
  id: row.id,
  source: row.source,
  kind: row.kind,
  threadId: row.thread_id as ThreadId,
  sourceThreadId: row.source_thread_id as ThreadId,
  at: Date.parse(row.at),
  ...(row.text === null ? {} : { text: row.text }),
  ...(row.replaces === null ? {} : { replaces: row.replaces }),
  state: row.state,
  heldUntil: row.held_until === null ? null : Date.parse(row.held_until),
  superseded: row.superseded === 1,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const readyLatch = yield* Deferred.make<void>();
  const changes = yield* PubSub.unbounded<void>();
  const checksAdded = yield* PubSub.unbounded<NeedsYouCheck>();
  const now = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
  // An ask, request or guest's message that has not ended: it can still remind.
  const openNeed = sql`source IN ('ask', 'request', 'guest') AND state != 'resolved'`;
  // Kept apart from the subjects, so pruning old ones never hands out a version again: browsers
  // skip versions they saw.
  const nextVersion = sql<{ readonly version: number }>`
    UPDATE needs_you_cursor SET version = version + 1 WHERE id = 1 RETURNING version
  `.pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined
        ? Effect.die("The needs-you cursor is not seeded")
        : Effect.succeed(rows[0].version),
    ),
  );

  const seedCursor = Effect.fn("NeedsYouLedger.seedCursor")(
    function* (input: { readonly sequence: number; readonly startedAt: number }) {
      const cutoff = iso((yield* now) - RETENTION_MS);
      // Needs still open stay however old, since a snooze can hold back their reminder, and so do
      // their reminders, so that none reminds twice.
      const pruned = sql`
        changed_at < ${cutoff} AND id NOT IN (
          SELECT id FROM needs_you_subjects WHERE ${openNeed}
          UNION ALL
          SELECT 'remind:' || id FROM needs_you_subjects WHERE ${openNeed}
        )
      `;
      yield* sql`
        DELETE FROM needs_you_deliveries WHERE subject_id IN (
          SELECT id FROM needs_you_subjects WHERE ${pruned}
        )
      `;
      yield* sql`DELETE FROM needs_you_subjects WHERE ${pruned}`;
      yield* sql`DELETE FROM needs_you_checks WHERE ended_at < ${cutoff}`;
      yield* sql`
        INSERT OR IGNORE INTO needs_you_cursor (id, sequence, started_at)
        VALUES (1, ${input.sequence}, ${iso(input.startedAt)})
      `;
      const rows = yield* sql<{ readonly sequence: number; readonly started_at: string }>`
        SELECT sequence, started_at FROM needs_you_cursor WHERE id = 1
      `;
      const row = rows[0];
      return row === undefined
        ? input
        : { sequence: row.sequence, startedAt: Date.parse(row.started_at) };
    },
    (effect) => sql.withTransaction(effect),
  );

  const known = Effect.fn("NeedsYouLedger.known")(function* (ids: ReadonlyArray<string>) {
    const found = new Map<string, Pick<StoredSubject, "state" | "superseded">>();
    if (ids.length === 0) return found;
    const rows = yield* sql<Pick<SubjectRow, "id" | "state" | "superseded">>`
      SELECT id, state, superseded FROM needs_you_subjects WHERE id IN ${sql.in(ids)}
    `;
    for (const row of rows) {
      found.set(row.id, { state: row.state, superseded: row.superseded === 1 });
    }
    return found;
  });

  const cancelOpenDeliveries = (ids: ReadonlyArray<string>) =>
    sql`
      UPDATE needs_you_deliveries SET status = 'cancelled'
      WHERE subject_id IN ${sql.in(ids)} AND status IN ('pending', 'failed')
    `;

  const insertDeliveries = (id: string, tokens: ReadonlyArray<string>) =>
    Effect.forEach(
      tokens,
      (token) =>
        sql`
          INSERT OR IGNORE INTO needs_you_deliveries (subject_id, token, status)
          VALUES (${id}, ${token}, 'pending')
        `,
      { discard: true },
    );

  const recordTransaction = Effect.fn("NeedsYouLedger.record")(
    function* (input: Parameters<NeedsYouLedger["Service"]["record"]>[0]) {
      const changedAt = iso(yield* now);
      let changed = false;
      for (const { subject, decision } of input.subjects) {
        const published = decision.state === "published";
        if ((yield* known([subject.id])).size > 0) continue;
        yield* sql`
          INSERT INTO needs_you_subjects (
            id, source, kind, thread_id, source_thread_id, at, text, replaces, state, version,
            changed_at
          ) VALUES (
            ${subject.id}, ${subject.source}, ${subject.kind}, ${subject.threadId},
            ${subject.sourceThreadId}, ${iso(subject.at)}, ${subject.text ?? null},
            ${subject.replaces ?? null}, ${decision.state},
            ${published ? yield* nextVersion : null}, ${changedAt}
          )
        `;
        if (!published) continue;
        changed = true;
        yield* insertDeliveries(subject.id, decision.tokens);
      }
      // A superseded completion is never presented again: clients learn it from a new version.
      for (const id of input.supersede ?? []) {
        const rows = yield* sql<{ readonly state: SubjectState; readonly version: number | null }>`
          SELECT state, version FROM needs_you_subjects
          WHERE id = ${id} AND kind = 'completed' AND superseded = 0
        `;
        const row = rows[0];
        if (row === undefined) continue;
        const published = row.state === "published";
        yield* sql`
          UPDATE needs_you_subjects
          SET superseded = 1, changed_at = ${changedAt},
            state = ${row.state === "waiting" ? "dropped" : row.state},
            version = ${published ? yield* nextVersion : row.version}
          WHERE id = ${id}
        `;
        yield* cancelOpenDeliveries([id]);
        if (published) changed = true;
      }
      if (input.resolve.length > 0) {
        const ids = [...input.resolve, ...input.resolve.map((id) => `remind:${id}`)];
        const resolved = yield* sql<{
          readonly id: string;
          readonly state: SubjectState;
          readonly version: number | null;
        }>`
          SELECT id, state, version FROM needs_you_subjects
          WHERE id IN ${sql.in(ids)} AND state != 'resolved'
        `;
        for (const row of resolved) {
          const published = row.state === "published";
          yield* sql`
            UPDATE needs_you_subjects
            SET state = 'resolved', changed_at = ${changedAt},
              version = ${published ? yield* nextVersion : row.version}
            WHERE id = ${row.id}
          `;
          if (published) changed = true;
        }
        if (resolved.length > 0) yield* cancelOpenDeliveries(resolved.map((row) => row.id));
      }
      // It alerted once already; an hour from now it reminds. One whose end clients never saw
      // keeps its state.
      for (const { id, at } of input.reopen ?? []) {
        yield* sql`
          UPDATE needs_you_subjects
          SET at = ${iso(at)},
            state = CASE state WHEN 'resolved' THEN 'dropped' ELSE state END,
            changed_at = CASE state WHEN 'resolved' THEN ${changedAt} ELSE changed_at END
          WHERE id = ${id}
        `;
      }
      const added: Array<NeedsYouCheck> = [];
      for (const check of input.checks) {
        const inserted = yield* sql`
          INSERT INTO needs_you_checks (run_id, thread_id, ended_at)
          VALUES (${check.runId}, ${check.threadId}, ${iso(check.endedAt)})
          ON CONFLICT(run_id) DO NOTHING
          RETURNING run_id
        `;
        if (inserted.length > 0) added.push({ runId: check.runId, threadId: check.threadId });
      }
      if (input.cursor !== undefined) {
        yield* sql`UPDATE needs_you_cursor SET sequence = ${input.cursor} WHERE id = 1`;
      }
      return { changed, added };
    },
    (effect) => sql.withTransaction(effect),
  );

  const record: NeedsYouLedger["Service"]["record"] = (input) =>
    recordTransaction(input).pipe(
      Effect.flatMap(({ changed, added }) =>
        Effect.andThen(
          changed ? PubSub.publish(changes, undefined) : Effect.void,
          PubSub.publishAll(checksAdded, added),
        ),
      ),
      Effect.asVoid,
    );

  const subjectRows = (rows: ReadonlyArray<SubjectRow>) => rows.map(storedSubject);

  const waiting = sql<SubjectRow>`
    SELECT * FROM needs_you_subjects WHERE state = 'waiting' ORDER BY at
  `.pipe(Effect.map(subjectRows));

  const decideWaiting: NeedsYouLedger["Service"]["decideWaiting"] = Effect.fn(
    "NeedsYouLedger.decideWaiting",
  )(
    function* (id, decision) {
      const changedAt = iso(yield* now);
      if (decision.state === "held") {
        yield* sql`
          UPDATE needs_you_subjects SET held_until = ${changedAt}
          WHERE id = ${id} AND state = 'waiting'
        `;
        return false;
      }
      if (decision.state === "waiting") return false;
      if ((yield* known([id])).get(id)?.state !== "waiting") return false;
      const published = decision.state === "published";
      yield* sql`
        UPDATE needs_you_subjects
        SET state = ${decision.state}, changed_at = ${changedAt},
          version = ${published ? yield* nextVersion : null}
        WHERE id = ${id}
      `;
      if (decision.state !== "published") return false;
      yield* insertDeliveries(id, decision.tokens);
      return true;
    },
    (effect) => sql.withTransaction(effect),
    Effect.tap((changed) => (changed ? PubSub.publish(changes, undefined) : Effect.void)),
    Effect.asVoid,
  );

  // However long ago a need started: a snooze may have kept its reminder for days.
  const unremindedNeeds = sql<SubjectRow>`
      SELECT * FROM needs_you_subjects need
      WHERE ${openNeed}
        AND NOT EXISTS (
          SELECT 1 FROM needs_you_subjects reminder WHERE reminder.id = 'remind:' || need.id
        )
      ORDER BY need.at
    `.pipe(Effect.map(subjectRows));

  const has = (id: string) =>
    sql`SELECT 1 FROM needs_you_subjects WHERE id = ${id}`.pipe(
      Effect.map((rows) => rows.length > 0),
    );

  const accepted = (id: string, token: string) =>
    sql`
      SELECT 1 FROM needs_you_deliveries
      WHERE subject_id = ${id} AND token = ${token} AND status = 'accepted'
    `.pipe(Effect.map((rows) => rows.length > 0));

  const deliveryOf = (
    row: (SubjectRow & { readonly token: string }) | undefined,
  ): NeedsYouDelivery | null =>
    row === undefined
      ? null
      : {
          subject: { ...storedSubject(row), publishedAt: Date.parse(row.changed_at) },
          token: row.token,
        };

  const nextDelivery = Effect.fn("NeedsYouLedger.nextDelivery")(function* (publishedSince: number) {
    const retryBefore = iso((yield* now) - RETRY_AFTER_MS);
    const rows = yield* sql<SubjectRow & { readonly token: string }>`
      SELECT subject.*, delivery.token AS token
      FROM needs_you_deliveries delivery
      JOIN needs_you_subjects subject ON subject.id = delivery.subject_id
      WHERE subject.state = 'published' AND subject.superseded = 0
        AND subject.changed_at >= ${iso(publishedSince)}
        AND (
          delivery.status = 'pending'
          OR (delivery.status = 'failed' AND delivery.attempted_at <= ${retryBefore})
        )
      ORDER BY subject.version, delivery.token
      LIMIT 1
    `;
    return deliveryOf(rows[0]);
  });

  const openDelivery: NeedsYouLedger["Service"]["openDelivery"] = Effect.fn(
    "NeedsYouLedger.openDelivery",
  )(function* (delivery) {
    const rows = yield* sql<SubjectRow & { readonly token: string }>`
      SELECT subject.*, delivery.token AS token
      FROM needs_you_deliveries delivery
      JOIN needs_you_subjects subject ON subject.id = delivery.subject_id
      WHERE subject.id = ${delivery.subjectId} AND delivery.token = ${delivery.token}
        AND subject.state = 'published' AND subject.superseded = 0
        AND delivery.status IN ('pending', 'failed')
    `;
    return deliveryOf(rows[0]);
  });

  const settle: NeedsYouLedger["Service"]["settle"] = Effect.fn("NeedsYouLedger.settle")(
    function* (delivery, outcome) {
      const attempted = outcome === "cancelled" ? 0 : 1;
      yield* sql`
        UPDATE needs_you_deliveries
        SET status = ${outcome}, attempts = attempts + ${attempted},
          attempted_at = ${iso(yield* now)}
        WHERE subject_id = ${delivery.subjectId} AND token = ${delivery.token}
      `;
    },
  );

  const recent = Effect.fn("NeedsYouLedger.recent")(function* (since: number) {
    const rows = yield* sql<SubjectRow>`
      SELECT * FROM needs_you_subjects
      WHERE version IS NOT NULL AND state IN ('published', 'resolved')
        AND changed_at >= ${iso(since)}
      ORDER BY version
    `;
    return rows.map((row): NeedsYouSubject => ({
      id: row.id,
      version: row.version ?? 0,
      source: row.source,
      kind: row.kind,
      threadId: row.thread_id as ThreadId,
      at: row.at,
      publishedAt: row.changed_at,
      ...(row.text === null ? {} : { text: row.text }),
      ...(row.replaces === null ? {} : { replaces: row.replaces }),
      resolved: row.state === "resolved",
      superseded: row.superseded === 1,
    }));
  });

  const pendingChecks = (since: number) =>
    sql<{ readonly run_id: string; readonly thread_id: string }>`
      SELECT run_id, thread_id FROM needs_you_checks
      WHERE checked_at IS NULL AND ended_at >= ${iso(since)}
      ORDER BY ended_at
    `.pipe(
      Effect.map((rows) =>
        rows.map((row) => ({ runId: row.run_id as RunId, threadId: row.thread_id as ThreadId })),
      ),
    );

  const isChecked = (runId: RunId) =>
    sql`SELECT 1 FROM needs_you_checks WHERE run_id = ${runId} AND checked_at IS NOT NULL`.pipe(
      Effect.map((rows) => rows.length > 0),
    );

  const markChecked = Effect.fn("NeedsYouLedger.markChecked")(function* (runId: RunId) {
    yield* sql`UPDATE needs_you_checks SET checked_at = ${iso(yield* now)} WHERE run_id = ${runId}`;
  });

  return NeedsYouLedger.of({
    seedCursor,
    ready: Deferred.await(readyLatch),
    markReady: Deferred.succeed(readyLatch, undefined).pipe(Effect.asVoid),
    known,
    record,
    waiting,
    decideWaiting,
    unremindedNeeds,
    has,
    accepted,
    nextDelivery,
    openDelivery,
    settle,
    recent,
    changes,
    pendingChecks,
    isChecked,
    markChecked,
    checksAdded,
  });
});

export const layer = Layer.effect(NeedsYouLedger, make);
