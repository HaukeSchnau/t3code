import {
  IsoDateTime,
  OrchestrationThreadSearchSource,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../../persistence/Errors.ts";
import {
  type ProjectionSnapshotCounts,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";

const ProjectionCountsRowSchema = Schema.Struct({
  projectCount: Schema.Number,
  threadCount: Schema.Number,
});
const ProjectionThreadSearchRequest = Schema.Struct({
  pattern: Schema.String,
  limit: Schema.Int,
});
const ProjectionThreadSearchRow = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  source: OrchestrationThreadSearchSource,
  matchText: Schema.String,
  messageCreatedAt: Schema.NullOr(IsoDateTime),
});

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ProjectionRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

function escapeLikePattern(value: string): string {
  return value.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_");
}

function foldAsciiCase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function buildSearchSnippet(text: string, query: string): string {
  const normalizedText = text.replace(/\s+/g, " ").trim();
  if (normalizedText.length <= 240) {
    return normalizedText;
  }
  const normalizedQuery = foldAsciiCase(query.replace(/\s+/g, " ").trim());
  const matchIndex = foldAsciiCase(normalizedText).indexOf(normalizedQuery);
  const bodyLength = 236;
  const idealStart = Math.max(0, matchIndex - 72);
  const start = Math.min(idealStart, normalizedText.length - bodyLength);
  const end = Math.min(normalizedText.length, start + bodyLength);
  return `${start > 0 ? "…" : ""}${normalizedText.slice(start, end)}${
    end < normalizedText.length ? "…" : ""
  }`;
}

export function makeProjectionSnapshotReads(input: {
  readonly sql: SqlClient.SqlClient;
}) {
  const readProjectionCounts = SqlSchema.findOne({
    Request: Schema.Void,
    Result: ProjectionCountsRowSchema,
    execute: () => input.sql`
      SELECT
        (SELECT COUNT(*) FROM projection_projects) AS "projectCount",
        (SELECT COUNT(*) FROM projection_threads) AS "threadCount"
    `,
  });

  const searchActiveThreadRows = SqlSchema.findAll({
    Request: ProjectionThreadSearchRequest,
    Result: ProjectionThreadSearchRow,
    execute: ({ pattern, limit }) => input.sql`
      WITH ranked AS (
        SELECT
          threads.thread_id AS thread_id,
          threads.project_id AS project_id,
          CASE messages.role
            WHEN 'user' THEN 'user'
            ELSE 'assistant'
          END AS source,
          messages.text AS match_text,
          messages.created_at AS message_created_at,
          CASE messages.role
            WHEN 'user' THEN 0
            ELSE 1
          END AS match_rank,
          threads.updated_at AS thread_updated_at,
          ROW_NUMBER() OVER (
            PARTITION BY threads.thread_id
            ORDER BY
              CASE messages.role
                WHEN 'user' THEN 0
                ELSE 1
              END ASC,
              messages.created_at DESC,
              messages.message_id ASC
          ) AS thread_match_rank
        FROM projection_thread_messages AS messages
        INNER JOIN projection_threads AS threads
          ON threads.thread_id = messages.thread_id
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
          AND projects.deleted_at IS NULL
          AND messages.is_streaming = 0
          AND (
            messages.role = 'user'
            OR (
              messages.role = 'assistant'
              AND messages.message_id IN (
                SELECT turns.assistant_message_id
                FROM projection_turns AS turns
                WHERE turns.assistant_message_id IS NOT NULL
              )
            )
          )
          AND messages.text LIKE ${pattern} ESCAPE '!'
      )
      SELECT
        thread_id AS "threadId",
        project_id AS "projectId",
        source,
        match_text AS "matchText",
        message_created_at AS "messageCreatedAt"
      FROM ranked
      WHERE thread_match_rank = 1
      ORDER BY
        match_rank ASC,
        thread_updated_at DESC,
        thread_id ASC
      LIMIT ${limit}
    `,
  });

  const getCounts: ProjectionSnapshotQueryShape["getCounts"] = () =>
    readProjectionCounts(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getCounts:query",
          "ProjectionSnapshotQuery.getCounts:decodeRow",
        ),
      ),
      Effect.map(
        (row): ProjectionSnapshotCounts => ({
          projectCount: row.projectCount,
          threadCount: row.threadCount,
        }),
      ),
    );

  const searchThreads: ProjectionSnapshotQueryShape["searchThreads"] = Effect.fn(
    "ProjectionSnapshotQuery.searchThreads",
  )(function* (searchInput) {
    const escapedQuery = escapeLikePattern(searchInput.query);
    const rows = yield* searchActiveThreadRows({
      pattern: `%${escapedQuery}%`,
      limit: searchInput.limit ?? 50,
    }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.searchThreads:query",
          "ProjectionSnapshotQuery.searchThreads:decodeRows",
        ),
      ),
    );
    return {
      matches: rows.map((row) => ({
        threadId: row.threadId,
        projectId: row.projectId,
        source: row.source,
        snippet: buildSearchSnippet(row.matchText, searchInput.query),
        messageCreatedAt: row.messageCreatedAt,
      })),
    };
  });

  return { getCounts, searchThreads };
}
