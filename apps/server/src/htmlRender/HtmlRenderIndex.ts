import {
  HtmlRenderPagesError,
  HtmlRenderRequestError,
  type HtmlRenderListPagesInput,
  type HtmlRenderMarkSeenInput,
  type HtmlRenderPage,
  type HtmlRenderPageChange,
  type HtmlRenderPageList,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ThreadAskId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { htmlRenderFromToolItem, htmlRenderUpdateFromToolItem } from "@t3tools/shared/toolOutput";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";

const DEFAULT_LIMIT = 50;

/** Thread changes that alter what a page list shows: its asks, title, or the thread itself. */
const LISTED_THREAD_EVENTS: ReadonlySet<OrchestrationV2DomainEvent["type"]> = new Set([
  "thread.asks-updated",
  "thread.settled",
  "thread.metadata-updated",
  "thread.deleted",
]);

interface PageRow {
  readonly render_id: string;
  readonly thread_id: string;
  readonly project_id: string;
  readonly thread_title: string;
  readonly title: string;
  readonly latest_attachment_id: string;
  readonly first_published_at: string;
  readonly latest_published_at: string;
  readonly version_count: number;
  readonly seen_at: string | null;
  readonly ask_id: string | null;
  readonly ask_text: string | null;
  readonly ask_raised_at: string | null;
  readonly waiting_last: number;
}

const pageFromRow = (row: PageRow): HtmlRenderPage => ({
  renderId: row.render_id,
  threadId: ThreadId.make(row.thread_id),
  projectId: ProjectId.make(row.project_id),
  threadTitle: row.thread_title,
  title: row.title,
  latestAttachmentId: row.latest_attachment_id,
  firstPublishedAt: row.first_published_at,
  latestPublishedAt: row.latest_published_at,
  versionCount: row.version_count,
  seenAt: row.seen_at,
  ask:
    row.ask_id === null || row.ask_text === null || row.ask_raised_at === null
      ? null
      : { id: ThreadAskId.make(row.ask_id), text: row.ask_text, raisedAt: row.ask_raised_at },
});

// Pages sort newest first, after a thread's waiting pages in its list, so a cursor is the last
// row's sort key.
const encodeCursor = (row: PageRow) =>
  `${row.waiting_last}|${row.latest_published_at}|${row.render_id}`;
const decodeCursor = (cursor: string) => {
  const key = /^([01])\|([^|]+)\|(.+)$/.exec(cursor);
  return key === null
    ? null
    : { waitingLast: Number(key[1]), publishedAt: key[2]!, renderId: key[3]! };
};

/** The index row of a page shown before the index existed, read from its tool calls. */
function pageFromToolCalls(
  renderId: string,
  rows: ReadonlyArray<{ readonly payload_json: string; readonly updated_at: string }>,
) {
  let page:
    | {
        title: string;
        firstPublishedAt: string;
        latestAttachmentId: string;
        latestPublishedAt: string;
        versionCount: number;
      }
    | undefined;
  for (const row of rows) {
    const payload = JSON.parse(row.payload_json) as { toolName?: unknown; output?: unknown };
    const item = {
      toolName: typeof payload.toolName === "string" ? payload.toolName : null,
      output: payload.output,
    };
    const shown = htmlRenderFromToolItem(item);
    const update = htmlRenderUpdateFromToolItem(item);
    if (shown?.attachmentId === renderId) {
      page = {
        title: shown.title,
        firstPublishedAt: row.updated_at,
        latestAttachmentId: renderId,
        latestPublishedAt: row.updated_at,
        versionCount: 1,
      };
    } else if (page !== undefined && update?.renderId === renderId) {
      page.title = update.title ?? page.title;
      page.latestAttachmentId = update.attachmentId;
      page.latestPublishedAt = row.updated_at;
      page.versionCount += 1;
    }
  }
  return page;
}

/** One row per page: its newest version, version count and whether a reader saw it. */
export class HtmlRenderIndex extends Context.Service<
  HtmlRenderIndex,
  {
    /**
     * A first version (no `renderId`) adds the page; a later one moves it forward as unseen. A page
     * shown before the index gets its row with its next version.
     */
    readonly recordPublished: (input: {
      readonly threadId: ThreadId;
      readonly attachmentId: string;
      readonly renderId?: string | undefined;
      /** A later version without a title keeps the page's title. */
      readonly title: string | undefined;
    }) => Effect.Effect<void, HtmlRenderPagesError>;
    /** Whether `renderId` is the first version of a page shown in the thread, indexed or not. */
    readonly isPage: (input: {
      readonly threadId: ThreadId;
      readonly renderId: string;
    }) => Effect.Effect<boolean, HtmlRenderPagesError>;
    readonly markSeen: (
      input: HtmlRenderMarkSeenInput,
    ) => Effect.Effect<void, HtmlRenderRequestError>;
    readonly list: (
      input: HtmlRenderListPagesInput,
    ) => Effect.Effect<HtmlRenderPageList, HtmlRenderPagesError>;
    /** One thread's page changes, or every thread's. */
    readonly changes: (
      threadId: ThreadId | undefined,
    ) => Stream.Stream<HtmlRenderPageChange, HtmlRenderPagesError>;
    /** A change to the thread that page lists may show (its asks, title, deletion). */
    readonly threadChanged: (threadId: ThreadId) => Effect.Effect<void>;
  }
>()("t3/htmlRender/HtmlRenderIndex") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const changedThreads = yield* PubSub.unbounded<ThreadId>();
  const changed = (threadId: ThreadId) => PubSub.publish(changedThreads, threadId);

  // Only an unindexed page reads its thread's tool calls, which the LIKE narrows.
  const pageShownBeforeIndex = (threadId: ThreadId, renderId: string) =>
    sql<{ payload_json: string; updated_at: string }>`
      SELECT payload_json, updated_at FROM orchestration_v2_projection_turn_items
      WHERE thread_id = ${threadId} AND type = 'dynamic_tool'
        AND payload_json LIKE ${`%${renderId}%`}
      ORDER BY ordinal
    `.pipe(
      Effect.flatMap((toolCalls) =>
        Effect.try({
          try: () => pageFromToolCalls(renderId, toolCalls),
          catch: (cause) => new HtmlRenderPagesError({ cause }),
        }),
      ),
    );

  const recordPublished = Effect.fn("HtmlRenderIndex.recordPublished")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly attachmentId: string;
      readonly renderId?: string | undefined;
      readonly title: string | undefined;
    }) {
      const now = DateTime.formatIso(yield* DateTime.now);
      const rows =
        input.renderId === undefined
          ? yield* sql<{ render_id: string }>`
              INSERT INTO html_renders (
                render_id, thread_id, title, first_published_at,
                latest_attachment_id, latest_published_at, version_count, seen_at
              )
              VALUES (
                ${input.attachmentId}, ${input.threadId}, ${input.title ?? ""}, ${now},
                ${input.attachmentId}, ${now}, 1, NULL
              )
              ON CONFLICT(render_id) DO NOTHING
              RETURNING render_id
            `
          : yield* sql<{ render_id: string }>`
              UPDATE html_renders SET
                latest_attachment_id = ${input.attachmentId},
                latest_published_at = ${now},
                version_count = version_count + 1,
                title = COALESCE(${input.title ?? null}, title),
                seen_at = NULL
              WHERE render_id = ${input.renderId} AND thread_id = ${input.threadId}
              RETURNING render_id
            `;
      if (rows.length > 0) yield* changed(input.threadId);
      else if (input.renderId !== undefined) {
        const shownBefore = yield* pageShownBeforeIndex(input.threadId, input.renderId);
        if (shownBefore === undefined) return;
        // An overlapping first update may have added the row since this one's UPDATE missed it.
        const upserted = yield* sql<{ render_id: string }>`
          INSERT INTO html_renders (
            render_id, thread_id, title, first_published_at,
            latest_attachment_id, latest_published_at, version_count, seen_at
          )
          VALUES (
            ${input.renderId}, ${input.threadId}, ${input.title ?? shownBefore.title},
            ${shownBefore.firstPublishedAt}, ${input.attachmentId}, ${now},
            ${shownBefore.versionCount + 1}, NULL
          )
          ON CONFLICT(render_id) DO UPDATE SET
            latest_attachment_id = excluded.latest_attachment_id,
            latest_published_at = excluded.latest_published_at,
            version_count = html_renders.version_count + 1,
            title = COALESCE(${input.title ?? null}, html_renders.title),
            seen_at = NULL
          WHERE html_renders.thread_id = excluded.thread_id
          RETURNING render_id
        `;
        if (upserted.length > 0) yield* changed(input.threadId);
      }
    },
    Effect.mapError((cause) => new HtmlRenderPagesError({ cause })),
  );

  const isPage = Effect.fn("HtmlRenderIndex.isPage")(
    function* (input: { readonly threadId: ThreadId; readonly renderId: string }) {
      const indexed = yield* sql<{ render_id: string }>`
        SELECT render_id FROM html_renders
        WHERE render_id = ${input.renderId} AND thread_id = ${input.threadId}
      `;
      return (
        indexed.length > 0 ||
        (yield* pageShownBeforeIndex(input.threadId, input.renderId)) !== undefined
      );
    },
    Effect.mapError((cause) => new HtmlRenderPagesError({ cause })),
  );

  const markSeen = Effect.fn("HtmlRenderIndex.markSeen")(
    function* (input: HtmlRenderMarkSeenInput) {
      const now = DateTime.formatIso(yield* DateTime.now);
      const rows = yield* sql<{ render_id: string }>`
        UPDATE html_renders SET seen_at = ${now}
        WHERE render_id = ${input.renderId} AND thread_id = ${input.threadId}
          AND latest_attachment_id = ${input.attachmentId} AND seen_at IS NULL
          AND EXISTS (
            SELECT 1 FROM orchestration_v2_projection_threads AS thread
            WHERE thread.thread_id = ${input.threadId} AND thread.deleted_at IS NULL
          )
        RETURNING render_id
      `;
      if (rows.length > 0) yield* changed(input.threadId);
    },
    (effect, input) =>
      Effect.mapError(
        effect,
        (cause) =>
          new HtmlRenderRequestError({ threadId: input.threadId, reason: "request-failed", cause }),
      ),
  );

  const list = Effect.fn("HtmlRenderIndex.list")(
    function* (input: HtmlRenderListPagesInput) {
      const limit = input.limit ?? DEFAULT_LIMIT;
      const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor);
      // A thread's list puts its waiting pages first, so its cut never hides one. The list of every
      // thread sorts by recency alone, so it walks html_renders_latest_idx instead of sorting.
      const ofThread = input.threadId !== undefined;
      const waitingLast = ofThread ? sql`(ask.value IS NULL)` : sql`0`;
      const older =
        cursor === null
          ? sql`1`
          : sql`(page.latest_published_at < ${cursor.publishedAt}
              OR (page.latest_published_at = ${cursor.publishedAt}
                AND page.render_id < ${cursor.renderId}))`;
      const rows = yield* sql<PageRow>`
        SELECT
          page.render_id,
          page.thread_id,
          thread.project_id,
          thread.title AS thread_title,
          page.title,
          page.latest_attachment_id,
          page.first_published_at,
          page.latest_published_at,
          page.version_count,
          page.seen_at,
          json_extract(ask.value, '$.id') AS ask_id,
          json_extract(ask.value, '$.text') AS ask_text,
          json_extract(ask.value, '$.raisedAt') AS ask_raised_at,
          ${waitingLast} AS waiting_last
        FROM html_renders AS page
        JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = page.thread_id
        LEFT JOIN json_each(thread.payload_json, '$.asks') AS ask
          ON json_extract(ask.value, '$.status') = 'open'
          AND json_extract(ask.value, '$.source.type') = 'page'
          AND json_extract(ask.value, '$.source.renderId') = page.render_id
        WHERE thread.deleted_at IS NULL
          AND ${ofThread ? sql`page.thread_id = ${input.threadId}` : sql`1`}
          AND ${
            input.filter === "asks"
              ? sql`ask.value IS NOT NULL`
              : input.filter === "unseen"
                ? sql`page.seen_at IS NULL`
                : sql`1`
          }
          AND ${
            cursor === null || !ofThread
              ? older
              : sql`(${waitingLast} > ${cursor.waitingLast}
                  OR (${waitingLast} = ${cursor.waitingLast} AND ${older}))`
          }
        ORDER BY ${ofThread ? sql`waiting_last, ` : sql``}page.latest_published_at DESC,
          page.render_id DESC
        LIMIT ${limit + 1}
      `.pipe(NodeSqliteClient.readOnly);
      const shown = rows.slice(0, limit);
      return {
        pages: shown.map(pageFromRow),
        nextCursor: rows.length > limit ? encodeCursor(shown.at(-1)!) : null,
      } satisfies HtmlRenderPageList;
    },
    Effect.mapError((cause) => new HtmlRenderPagesError({ cause })),
  );

  const countPages = (threadId: ThreadId | undefined) =>
    sql<{ pages: number }>`
      SELECT COUNT(*) AS pages
      FROM html_renders AS page
      JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = page.thread_id
      WHERE thread.deleted_at IS NULL
        AND ${threadId === undefined ? sql`1` : sql`page.thread_id = ${threadId}`}
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.map((rows) => rows[0]?.pages ?? 0),
      Effect.mapError((cause) => new HtmlRenderPagesError({ cause })),
    );

  const changes = (threadId: ThreadId | undefined) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before the first count so a change during it still arrives.
        const subscription = yield* PubSub.subscribe(changedThreads);
        let revision = 0;
        const next = countPages(threadId).pipe(
          Effect.map((pages) => ({ revision: revision++, pages })),
        );
        return Stream.concat(
          Stream.fromEffect(next),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((changedId) => threadId === undefined || changedId === threadId),
            Stream.mapEffect(() => next),
          ),
        );
      }),
    );

  const threadChanged = (threadId: ThreadId) =>
    sql<{ render_id: string }>`
      SELECT render_id FROM html_renders WHERE thread_id = ${threadId} LIMIT 1
    `.pipe(
      Effect.flatMap((rows) => (rows.length > 0 ? changed(threadId) : Effect.void)),
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not check a thread's pages", { threadId, cause }),
      ),
      Effect.asVoid,
    );

  return HtmlRenderIndex.of({
    recordPublished,
    isPage,
    markSeen,
    list,
    changes,
    threadChanged,
  });
});

export const layer = Layer.effect(HtmlRenderIndex, make);

/** The index, telling page lists about thread changes they show. */
export const layerWithThreadChanges = Layer.effectDiscard(
  Effect.gen(function* () {
    const index = yield* HtmlRenderIndex;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    yield* forkParked(
      Stream.runForEach(threads.streamDomainEvents, (event) =>
        LISTED_THREAD_EVENTS.has(event.type) ? index.threadChanged(event.threadId) : Effect.void,
      ).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("Page index thread stream failed", { cause }),
        ),
      ),
    );
  }),
).pipe(Layer.provideMerge(layer));
