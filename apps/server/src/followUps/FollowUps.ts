import {
  FollowUp,
  FollowUpActor,
  FollowUpError,
  FollowUpFields,
  FollowUpGardenerRun,
  FollowUpId,
  FollowUpLink,
  FollowUpOrigin,
  FollowUpStatus,
  FollowUpThreadRef,
  FollowUpType,
  FollowUpTypeField,
  type FollowUpChange,
  type FollowUpSaveInput,
  type FollowUpsSnapshot,
  type FollowUpsSubscribeInput,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as DueHint from "../scheduling/DueHint.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";

export interface FollowUpSearchInput {
  readonly query?: string | undefined;
  readonly ids?: ReadonlyArray<FollowUpId> | undefined;
  /** Defaults to open and picked-up follow-ups. */
  readonly statuses?: ReadonlyArray<FollowUpStatus> | undefined;
  readonly tags?: ReadonlyArray<string> | undefined;
  readonly type?: string | undefined;
  readonly limit?: number | undefined;
}

export interface FollowUpMatch {
  readonly followUp: FollowUp;
  readonly score: number;
}

export interface FollowUpTypeInput {
  readonly name: string;
  readonly description: string;
  readonly fields: ReadonlyArray<FollowUpTypeField>;
}

export class FollowUps extends Context.Service<
  FollowUps,
  {
    readonly snapshot: (
      input: FollowUpsSubscribeInput,
    ) => Effect.Effect<FollowUpsSnapshot, FollowUpError>;
    readonly subscribe: (
      input: FollowUpsSubscribeInput,
    ) => Stream.Stream<FollowUpsSnapshot, FollowUpError>;
    readonly search: (
      input: FollowUpSearchInput,
    ) => Effect.Effect<ReadonlyArray<FollowUpMatch>, FollowUpError>;
    readonly save: (
      input: FollowUpSaveInput,
      actor: FollowUpActor,
    ) => Effect.Effect<FollowUp, FollowUpError>;
    readonly history: (
      id: FollowUpId,
    ) => Effect.Effect<ReadonlyArray<FollowUpChange>, FollowUpError>;
    readonly types: Effect.Effect<ReadonlyArray<FollowUpType>, FollowUpError>;
    /** Defines a type and saves a follow-up in one transaction; either may be left out. */
    readonly apply: (
      input: { readonly defineType?: FollowUpTypeInput; readonly save?: FollowUpSaveInput },
      actor: FollowUpActor,
    ) => Effect.Effect<
      { readonly type?: FollowUpType; readonly followUp?: FollowUp },
      FollowUpError
    >;
    readonly recordGardenerRun: (run: FollowUpGardenerRun) => Effect.Effect<void, FollowUpError>;
    /** Whether a nightly gardener run started this thread, so its changes log as the gardener's. */
    readonly isGardenerThread: (thread: FollowUpThreadRef) => Effect.Effect<boolean>;
  }
>()("t3/followUps/FollowUps") {}

const Row = Schema.Struct({
  id: FollowUpId,
  title: Schema.String,
  body: Schema.String,
  status: FollowUpStatus,
  due_at: Schema.NullOr(Schema.String),
  condition: Schema.NullOr(Schema.String),
  tags_json: Schema.fromJsonString(Schema.Array(Schema.String)),
  links_json: Schema.fromJsonString(Schema.Array(FollowUpLink)),
  type: Schema.NullOr(Schema.String),
  fields_json: Schema.fromJsonString(FollowUpFields),
  origin_json: Schema.NullOr(Schema.fromJsonString(FollowUpOrigin)),
  picked_up_thread_json: Schema.NullOr(Schema.fromJsonString(FollowUpThreadRef)),
  result: Schema.NullOr(Schema.String),
  merged_into: Schema.NullOr(FollowUpId),
  returned_at: Schema.NullOr(Schema.String),
  created_by_json: Schema.fromJsonString(FollowUpActor),
  created_at: Schema.String,
  updated_at: Schema.String,
  closed_at: Schema.NullOr(Schema.String),
});
const decodeRow = Schema.decodeUnknownEffect(Row);
const encodeRow = Schema.encodeEffect(Row);

const TypeRow = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  fields_json: Schema.fromJsonString(Schema.Array(FollowUpTypeField)),
  updated_at: Schema.String,
});
const decodeTypeRow = Schema.decodeUnknownEffect(TypeRow);
const encodeTypeFields = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(FollowUpTypeField)),
);

const ChangeRow = Schema.Struct({
  follow_up_id: FollowUpId,
  at: Schema.String,
  actor_json: Schema.fromJsonString(FollowUpActor),
  summary: Schema.String,
});
const decodeChangeRow = Schema.decodeUnknownEffect(ChangeRow);
const encodeActor = Schema.encodeEffect(Schema.fromJsonString(FollowUpActor));

const GardenerRow = Schema.Struct({
  thread_json: Schema.fromJsonString(FollowUpThreadRef),
  started_at: Schema.String,
});
const decodeGardenerRow = Schema.decodeUnknownEffect(GardenerRow);
const encodeThreadRef = Schema.encodeEffect(Schema.fromJsonString(FollowUpThreadRef));

const fromRow = (row: typeof Row.Type): FollowUp => ({
  id: row.id,
  title: row.title,
  body: row.body,
  status: row.status,
  dueAt: row.due_at,
  condition: row.condition,
  tags: row.tags_json,
  links: row.links_json,
  type: row.type,
  fields: row.fields_json,
  origin: row.origin_json,
  pickedUpThread: row.picked_up_thread_json,
  result: row.result,
  mergedInto: row.merged_into,
  returnedAt: row.returned_at,
  createdBy: row.created_by_json,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  closedAt: row.closed_at,
});

const toRow = (followUp: FollowUp): typeof Row.Type => ({
  id: followUp.id,
  title: followUp.title,
  body: followUp.body,
  status: followUp.status,
  due_at: followUp.dueAt,
  condition: followUp.condition,
  tags_json: followUp.tags,
  links_json: followUp.links,
  type: followUp.type,
  fields_json: followUp.fields,
  origin_json: followUp.origin,
  picked_up_thread_json: followUp.pickedUpThread,
  result: followUp.result,
  merged_into: followUp.mergedInto,
  returned_at: followUp.returnedAt,
  created_by_json: followUp.createdBy,
  created_at: followUp.createdAt,
  updated_at: followUp.updatedAt,
  closed_at: followUp.closedAt,
});

const CLOSED_STATUSES: ReadonlySet<FollowUpStatus> = new Set(["done", "dropped", "merged"]);
const ACTIVE_STATUSES: ReadonlyArray<FollowUpStatus> = ["open", "picked_up"];
const CLOSED_SNAPSHOT_LIMIT = 200;

const isFollowUpError = Schema.is(FollowUpError);
const fail = (message: string) => new FollowUpError({ message });
const failWith =
  (message: string) =>
  (cause: unknown): FollowUpError =>
    new FollowUpError({ message, cause });

/** Tags compare case-insensitively and keep their first spelling. */
const normalizeTags = (tags: ReadonlyArray<string>) => {
  const seen = new Map<string, string>();
  for (const tag of tags) {
    const trimmed = tag.trim();
    if (trimmed !== "" && !seen.has(trimmed.toLowerCase()))
      seen.set(trimmed.toLowerCase(), trimmed);
  }
  return [...seen.values()];
};

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "for",
  "from",
  "how",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

const searchTerms = (query: string) => [
  ...new Set(
    query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((term) => term.length > 1 && !STOP_WORDS.has(term)),
  ),
];

/** Title hits weigh most, then tags and type, then the body and fields. */
const scoreFollowUp = (followUp: FollowUp, terms: ReadonlyArray<string>) => {
  if (terms.length === 0) return 0;
  const title = followUp.title.toLowerCase();
  const labels = [...followUp.tags, followUp.type ?? ""].join(" ").toLowerCase();
  const rest = `${followUp.body} ${followUp.condition ?? ""} ${JSON.stringify(followUp.fields)} ${
    followUp.origin?.quote ?? ""
  }`.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (title.includes(term)) score += 3;
    else if (labels.includes(term)) score += 2;
    else if (rest.includes(term)) score += 1;
  }
  return score / (3 * terms.length);
};

/** Stored as UTC ISO text, so the due scan can compare dates as strings. */
const normalizeDate = (value: string) =>
  Option.match(DateTime.make(value), {
    onNone: () =>
      Effect.fail(
        fail(`"${value}" is not a date. Use an ISO date-time such as 2026-12-01T09:00:00Z.`),
      ),
    onSome: (date) => Effect.succeed(DateTime.formatIso(date)),
  });

const STATUS_WORDS: Record<FollowUpStatus, string> = {
  open: "open",
  picked_up: "picked up",
  done: "done",
  dropped: "dropped",
  merged: "merged",
};

const describeChanges = (before: FollowUp, after: FollowUp) => {
  const parts: Array<string> = [];
  const statusChanged = before.status !== after.status;
  const pickedUpIn =
    after.pickedUpThread !== null &&
    JSON.stringify(before.pickedUpThread) !== JSON.stringify(after.pickedUpThread)
      ? ` in thread ${after.pickedUpThread.threadId}`
      : "";
  if (
    after.status === "merged" &&
    after.mergedInto !== null &&
    (statusChanged || before.mergedInto !== after.mergedInto)
  ) {
    parts.push(`merged into ${after.mergedInto}`);
  } else if (statusChanged) {
    parts.push(`${STATUS_WORDS[before.status]} → ${STATUS_WORDS[after.status]}${pickedUpIn}`);
  } else if (pickedUpIn !== "") {
    parts.push(`picked up${pickedUpIn}`);
  }
  if (before.title !== after.title) parts.push(`renamed from "${before.title}"`);
  const changed = (
    [
      ["body", before.body !== after.body],
      ["date", before.dueAt !== after.dueAt],
      ["condition", before.condition !== after.condition],
      ["tags", JSON.stringify(before.tags) !== JSON.stringify(after.tags)],
      ["links", JSON.stringify(before.links) !== JSON.stringify(after.links)],
      ["type", before.type !== after.type],
      ["fields", JSON.stringify(before.fields) !== JSON.stringify(after.fields)],
      ["result", before.result !== after.result],
    ] as const
  ).flatMap(([name, isChanged]) => (isChanged ? [name] : []));
  if (changed.length > 0) parts.push(`changed ${changed.join(", ")}`);
  if (
    after.result !== null &&
    after.result !== before.result &&
    CLOSED_STATUSES.has(after.status)
  ) {
    parts.push(`result: ${after.result}`);
  }
  return parts.join("; ");
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const random = yield* SecureRandom.SecureRandom;
  const scheduler = yield* Scheduler.Scheduler;
  const changes = yield* PubSub.sliding<void>(1);
  const due = DueHint.make();

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const notifyChanged = Effect.andThen(due.invalidate, PubSub.publish(changes, undefined));

  const decodeAll = (rows: ReadonlyArray<unknown>) =>
    Effect.forEach(rows, (row) =>
      decodeRow(row).pipe(
        Effect.map(fromRow),
        Effect.map((followUp) => [followUp]),
        Effect.catchCause((cause) =>
          Effect.logWarning("Skipping an unreadable follow-up", { cause }).pipe(Effect.as([])),
        ),
      ),
    ).pipe(Effect.map((groups) => groups.flat()));

  const loadActive = sql`
    SELECT * FROM follow_ups WHERE status IN ('open', 'picked_up') ORDER BY created_at DESC
  `.pipe(NodeSqliteClient.readOnly, Effect.flatMap(decodeAll));

  const loadClosed = (limit: number) =>
    sql`
      SELECT * FROM follow_ups WHERE status NOT IN ('open', 'picked_up')
      ORDER BY closed_at DESC LIMIT ${limit}
    `.pipe(NodeSqliteClient.readOnly, Effect.flatMap(decodeAll));

  const loadAll = sql`SELECT * FROM follow_ups ORDER BY created_at DESC`.pipe(
    NodeSqliteClient.readOnly,
    Effect.flatMap(decodeAll),
  );

  const load = (id: FollowUpId) =>
    sql`SELECT * FROM follow_ups WHERE id = ${id}`.pipe(
      Effect.flatMap(decodeAll),
      Effect.map((rows) => rows[0] ?? null),
    );

  const types = sql`SELECT * FROM follow_up_types ORDER BY name`.pipe(
    NodeSqliteClient.readOnly,
    Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeTypeRow(row))),
    Effect.map((rows) =>
      rows.map((row): FollowUpType => ({
        name: row.name,
        description: row.description,
        fields: row.fields_json,
        updatedAt: row.updated_at,
      })),
    ),
    Effect.mapError(failWith("Could not read follow-up types")),
  );

  const lastGardenerRun = sql`
    SELECT * FROM follow_up_gardener_runs ORDER BY started_at DESC LIMIT 1
  `.pipe(
    NodeSqliteClient.readOnly,
    Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeGardenerRow(row))),
    Effect.map((rows) =>
      rows[0] === undefined
        ? null
        : ({
            thread: rows[0].thread_json,
            startedAt: rows[0].started_at,
          } satisfies FollowUpGardenerRun),
    ),
  );

  const snapshot: FollowUps["Service"]["snapshot"] = Effect.fn("FollowUps.snapshot")(
    function* (input) {
      const active = yield* loadActive;
      const closed = input.includeClosed === true ? yield* loadClosed(CLOSED_SNAPSHOT_LIMIT) : [];
      return {
        followUps: [...active, ...closed],
        types: yield* types,
        lastGardenerRun: yield* lastGardenerRun,
      };
    },
    Effect.mapError(failWith("Could not read follow-ups")),
  );

  const subscribe: FollowUps["Service"]["subscribe"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before reading so a change during the first read still arrives.
        const subscription = yield* PubSub.subscribe(changes);
        return Stream.concat(
          Stream.fromEffect(snapshot(input)),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => snapshot(input))),
        );
      }),
    );

  const search: FollowUps["Service"]["search"] = Effect.fn("FollowUps.search")(
    function* (input) {
      const statuses = new Set(input.statuses ?? ACTIVE_STATUSES);
      const onlyActive = [...statuses].every((status) => !CLOSED_STATUSES.has(status));
      // Exact ids read closed follow-ups too.
      const candidates = input.ids === undefined && onlyActive ? yield* loadActive : yield* loadAll;
      const ids = input.ids === undefined ? null : new Set(input.ids);
      const tags = (input.tags ?? []).map((tag) => tag.toLowerCase());
      const terms = searchTerms(input.query ?? "");
      const matches = candidates.flatMap((followUp): Array<FollowUpMatch> => {
        if (ids !== null) return ids.has(followUp.id) ? [{ followUp, score: 1 }] : [];
        if (!statuses.has(followUp.status)) return [];
        if (input.type !== undefined && followUp.type !== input.type) return [];
        const ownTags = new Set(followUp.tags.map((tag) => tag.toLowerCase()));
        if (!tags.every((tag) => ownTags.has(tag))) return [];
        if (terms.length === 0) return [{ followUp, score: 0 }];
        const score = scoreFollowUp(followUp, terms);
        return score > 0 ? [{ followUp, score }] : [];
      });
      matches.sort(
        (left, right) =>
          right.score - left.score ||
          right.followUp.updatedAt.localeCompare(left.followUp.updatedAt),
      );
      return matches.slice(0, input.limit ?? 20);
    },
    Effect.mapError((cause) =>
      isFollowUpError(cause) ? cause : failWith("Could not search follow-ups")(cause),
    ),
  );

  const recordChange = (
    followUpId: FollowUpId,
    actor: FollowUpActor,
    summary: string,
    at: string,
  ) =>
    encodeActor(actor).pipe(
      Effect.flatMap(
        (actorJson) => sql`
          INSERT INTO follow_up_changes (follow_up_id, at, actor_json, summary)
          VALUES (${followUpId}, ${at}, ${actorJson}, ${summary})
        `,
      ),
    );

  const write = (followUp: FollowUp, mode: "insert" | "update") =>
    encodeRow(toRow(followUp)).pipe(
      Effect.flatMap((row) =>
        mode === "insert"
          ? sql`INSERT INTO follow_ups ${sql.insert(row)}`
          : sql`
              UPDATE follow_ups SET ${sql.update(row, ["id"])} WHERE id = ${row.id}
            `,
      ),
    );

  const newId = Effect.gen(function* () {
    for (;;) {
      const uuid = yield* random.uuidV4();
      const id = FollowUpId.make(`fu-${uuid.replaceAll("-", "").slice(0, 8)}`);
      if ((yield* load(id)) === null) return id;
    }
  });

  const checkTypeAndFields = Effect.fn("FollowUps.checkTypeAndFields")(function* (
    type: string | null,
    fields: FollowUpFields,
  ) {
    const fieldNames = Object.keys(fields);
    if (type === null) {
      if (fieldNames.length > 0) {
        return yield* fail(
          "Fields belong to a type. Name the follow-up's type, or leave fields out.",
        );
      }
      return;
    }
    const known = yield* types;
    const definition = known.find((entry) => entry.name === type);
    if (definition === undefined) {
      const names = known.map((entry) => entry.name);
      return yield* fail(
        `There is no follow-up type "${type}". ${
          names.length === 0 ? "No types exist yet." : `Existing types: ${names.join(", ")}.`
        } Define it first, or use an existing one.`,
      );
    }
    const allowed = new Set(definition.fields.map((field) => field.name));
    const unknown = fieldNames.filter((name) => !allowed.has(name));
    if (unknown.length > 0) {
      return yield* fail(
        `The type "${type}" has no field ${unknown.join(", ")}. Its fields: ${
          [...allowed].join(", ") || "none"
        }. Add fields to the type first.`,
      );
    }
  });

  const checkLinks = Effect.fn("FollowUps.checkLinks")(function* (
    id: FollowUpId,
    links: ReadonlyArray<FollowUpLink>,
  ) {
    for (const link of links) {
      if (link.target.type !== "followUp") continue;
      if (link.target.followUpId === id) return yield* fail("A follow-up cannot link to itself.");
      if ((yield* load(link.target.followUpId)) === null) {
        return yield* fail(`There is no follow-up ${link.target.followUpId} to link to.`);
      }
    }
  });

  // One transaction from read to write, so a concurrent save cannot revert this one.
  const saveRow = Effect.fnUntraced(function* (input: FollowUpSaveInput, actor: FollowUpActor) {
    const now = yield* nowIso;
    const before = input.id === undefined ? null : yield* load(input.id);
    if (input.id !== undefined && before === null) {
      return yield* fail(`There is no follow-up ${input.id}.`);
    }
    if (before === null && input.title === undefined) {
      return yield* fail("A new follow-up needs a title.");
    }
    if (before !== null && input.origin !== undefined) {
      return yield* fail("A follow-up's origin is set when it is written and does not change.");
    }
    const id = before?.id ?? (yield* newId);
    const base: FollowUp = before ?? {
      id,
      title: "",
      body: "",
      status: "open",
      dueAt: null,
      condition: null,
      tags: [],
      links: [],
      type: null,
      fields: {},
      origin: input.origin ?? null,
      pickedUpThread: null,
      result: null,
      mergedInto: null,
      returnedAt: null,
      createdBy: actor,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    const status = input.status ?? base.status;
    const dueAt =
      input.dueAt === undefined || input.dueAt === null
        ? (input.dueAt ?? base.dueAt)
        : yield* normalizeDate(input.dueAt);
    const mergedInto =
      input.mergedInto === undefined
        ? status === "merged"
          ? base.mergedInto
          : null
        : input.mergedInto;
    if (status === "merged") {
      if (mergedInto === null)
        return yield* fail("A merged follow-up names the one it merged into.");
      if (mergedInto === id) return yield* fail("A follow-up cannot merge into itself.");
      if ((yield* load(mergedInto)) === null)
        return yield* fail(`There is no follow-up ${mergedInto}.`);
    }
    const next: FollowUp = {
      ...base,
      title: input.title ?? base.title,
      body: input.body ?? base.body,
      status,
      dueAt,
      condition: input.condition === undefined ? base.condition : input.condition,
      tags: input.tags === undefined ? base.tags : normalizeTags(input.tags),
      links: input.links ?? base.links,
      type: input.type === undefined ? base.type : input.type,
      fields: input.fields ?? base.fields,
      pickedUpThread:
        input.pickedUpThread === undefined ? base.pickedUpThread : input.pickedUpThread,
      // Reopening drops the old result; the next close writes its own.
      result:
        input.result !== undefined
          ? input.result
          : CLOSED_STATUSES.has(base.status) && !CLOSED_STATUSES.has(status)
            ? null
            : base.result,
      mergedInto,
      // A new date sends it back to waiting; the scanner returns it once the date arrives.
      returnedAt: dueAt !== base.dueAt || status !== "open" ? null : base.returnedAt,
      updatedAt: now,
      closedAt: CLOSED_STATUSES.has(status) ? (base.closedAt ?? now) : null,
    };
    if (status === "picked_up" && next.pickedUpThread === null) {
      return yield* fail("A picked-up follow-up names the thread that picked it up.");
    }
    yield* checkTypeAndFields(next.type, next.fields);
    yield* checkLinks(id, next.links);
    const summary = before === null ? "created" : describeChanges(before, next);
    if (before !== null && summary === "") return { followUp: before, changed: false };
    yield* write(next, before === null ? "insert" : "update");
    yield* recordChange(id, actor, summary, now);
    return { followUp: next, changed: true };
  });

  const save: FollowUps["Service"]["save"] = Effect.fn("FollowUps.save")(
    function* (input, actor) {
      const saved = yield* saveRow(input, actor).pipe(sql.withTransaction);
      if (saved.changed) yield* notifyChanged;
      return saved.followUp;
    },
    Effect.mapError((cause) =>
      isFollowUpError(cause) ? cause : failWith("Could not save the follow-up")(cause),
    ),
  );

  const history: FollowUps["Service"]["history"] = Effect.fn("FollowUps.history")(
    function* (id) {
      const rows = yield* sql`
        SELECT * FROM follow_up_changes WHERE follow_up_id = ${id} ORDER BY id
      `.pipe(NodeSqliteClient.readOnly);
      const decoded = yield* Effect.forEach(rows, (row) => decodeChangeRow(row));
      return decoded.map((row): FollowUpChange => ({
        followUpId: row.follow_up_id,
        at: row.at,
        actor: row.actor_json,
        summary: row.summary,
      }));
    },
    Effect.mapError(failWith("Could not read the follow-up's history")),
  );

  const defineTypeRow = Effect.fnUntraced(function* (
    input: FollowUpTypeInput,
    actor: FollowUpActor,
  ) {
    const name = input.name.trim();
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      return yield* fail("A type name is one lowercase word, such as risk or idea.");
    }
    const fieldNames = input.fields.map((field) => field.name);
    if (new Set(fieldNames).size !== fieldNames.length) {
      return yield* fail("A type names each field once.");
    }
    const now = yield* nowIso;
    const existing = (yield* types).find((entry) => entry.name === name);
    if (existing !== undefined) {
      const kept = new Set(fieldNames);
      const dropped = existing.fields
        .filter((field) => !kept.has(field.name))
        .map((field) => field.name);
      const inUse = (yield* loadAll).filter(
        (followUp) =>
          followUp.type === name && dropped.some((field) => Object.hasOwn(followUp.fields, field)),
      );
      if (inUse.length > 0) {
        return yield* fail(
          `Follow-ups ${inUse.map((followUp) => followUp.id).join(", ")} still use the field${
            dropped.length === 1 ? "" : "s"
          } ${dropped.join(", ")}. Move their values first.`,
        );
      }
    }
    const fieldsJson = yield* encodeTypeFields(input.fields);
    yield* sql`
        INSERT INTO follow_up_types (name, description, fields_json, updated_at)
        VALUES (${name}, ${input.description}, ${fieldsJson}, ${now})
        ON CONFLICT(name) DO UPDATE SET
          description = excluded.description,
          fields_json = excluded.fields_json,
          updated_at = excluded.updated_at
      `;
    yield* Effect.logInfo("Follow-up type saved", { name, actor: actor.kind });
    return { name, description: input.description, fields: input.fields, updatedAt: now };
  });

  // A type and the follow-up that uses it land together or not at all.
  const apply: FollowUps["Service"]["apply"] = Effect.fn("FollowUps.apply")(
    function* (input, actor) {
      const result = yield* Effect.gen(function* () {
        const type =
          input.defineType === undefined
            ? undefined
            : yield* defineTypeRow(input.defineType, actor);
        const saved = input.save === undefined ? undefined : yield* saveRow(input.save, actor);
        return { type, saved };
      }).pipe(sql.withTransaction);
      if (result.type !== undefined || result.saved?.changed === true) yield* notifyChanged;
      return {
        ...(result.type === undefined ? {} : { type: result.type }),
        ...(result.saved === undefined ? {} : { followUp: result.saved.followUp }),
      };
    },
    Effect.mapError((cause) =>
      isFollowUpError(cause) ? cause : failWith("Could not save the follow-up")(cause),
    ),
  );

  const recordGardenerRun: FollowUps["Service"]["recordGardenerRun"] = (run) =>
    encodeThreadRef(run.thread).pipe(
      Effect.flatMap(
        (threadJson) => sql`
          INSERT INTO follow_up_gardener_runs (thread_json, started_at)
          VALUES (${threadJson}, ${run.startedAt})
        `,
      ),
      Effect.andThen(notifyChanged),
      Effect.mapError(failWith("Could not record the gardener run")),
    );

  const isGardenerThread: FollowUps["Service"]["isGardenerThread"] = (thread) =>
    encodeThreadRef(thread).pipe(
      Effect.flatMap(
        (threadJson) => sql<{ readonly found: number }>`
          SELECT 1 AS found FROM follow_up_gardener_runs WHERE thread_json = ${threadJson} LIMIT 1
        `,
      ),
      Effect.map((rows) => rows.length > 0),
      Effect.orElseSucceed(() => false),
    );

  /** Returns dated follow-ups to the inbox once their date arrives. */
  const returnDue = Effect.fn("FollowUps.returnDue")(function* () {
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    if (yield* due.isIdle(nowMs)) return;
    const readVersion = yield* due.version;
    const nowText = DateTime.formatIso(now);
    const returned = yield* sql<{ readonly id: string }>`
      UPDATE follow_ups SET returned_at = ${nowText}
      WHERE status = 'open' AND due_at IS NOT NULL AND returned_at IS NULL AND due_at <= ${nowText}
      RETURNING id
    `;
    if (returned.length > 0) {
      yield* Effect.logInfo("Follow-ups returned to the inbox", { count: returned.length });
      yield* notifyChanged;
      return;
    }
    const [next] = yield* sql<{ readonly due_at: string | null }>`
      SELECT MIN(due_at) AS due_at FROM follow_ups
      WHERE status = 'open' AND due_at IS NOT NULL AND returned_at IS NULL
    `.pipe(NodeSqliteClient.readOnly);
    const nextDueMs =
      next?.due_at == null
        ? Option.some(Infinity)
        : DateTime.make(next.due_at).pipe(Option.map(DateTime.toEpochMillis));
    if (Option.isSome(nextDueMs)) yield* due.record(readVersion, nextDueMs.value, nowMs);
  });

  yield* scheduler.register("follow-ups", returnDue());

  return FollowUps.of({
    snapshot,
    subscribe,
    search,
    save,
    history,
    types,
    apply,
    recordGardenerRun,
    isGardenerThread,
  });
});

export const layer = Layer.effect(FollowUps, make);
