import type {
  OrchestrationFindInThreadInput,
  OrchestrationFindInThreadResult,
  OrchestrationThreadFindField,
  OrchestrationThreadFindMatch,
} from "@t3tools/contracts";
import {
  compileThreadFind,
  findThreadMatches,
  THREAD_FIND_DETAIL_EXCERPT,
  THREAD_FIND_TEXT_EXCERPT,
  threadFindExcerpts,
  threadFindItemMessageId,
  threadFindItemSource,
  threadFindItemText,
  type ThreadFindExcerptOptions,
} from "@t3tools/shared/threadFind";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "./ProjectionStore.ts";
import { projectTurnItemForWire } from "./WireProjection.ts";

// Keeps a response well under a megabyte even when every match has an excerpt.
const MATCH_LIMIT = 500;
// Tool output can run to megabytes. Only its start is searched.
const DETAIL_SEARCH_CHARS = 256 * 1024;
// Bounds how much one find reads and decodes on the shared SQLite connection.
const PAYLOAD_BUDGET_BYTES = 64 * 1024 * 1024;

/**
 * Finds matches in one thread's visible timeline, including rows inherited from
 * a fork source, in timeline order.
 */
export class ThreadFind extends Context.Service<
  ThreadFind,
  {
    readonly find: (
      input: OrchestrationFindInThreadInput,
    ) => Effect.Effect<OrchestrationFindInThreadResult, ProjectionStore.ProjectionStoreV2Error>;
  }
>()("t3/orchestration-v2/ThreadFind") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  const find: ThreadFind["Service"]["find"] = Effect.fn("ThreadFind.find")(function* (input) {
    const matcher = compileThreadFind(input);
    if (matcher?._tag !== "Valid") return { matches: [], truncated: false };

    const matches: Array<OrchestrationThreadFindMatch> = [];
    const scan = yield* projections.scanTimeline(
      input.threadId,
      { maxPayloadBytes: PAYLOAD_BUDGET_BYTES },
      (row) => {
        const collect = (
          field: OrchestrationThreadFindField,
          value: string,
          options: ThreadFindExcerptOptions,
        ) => {
          const ranges = findThreadMatches(matcher, value, MATCH_LIMIT - matches.length);
          const messageId = threadFindItemMessageId(row.item);
          threadFindExcerpts(value, ranges, options).forEach((excerpt, occurrence) =>
            matches.push({
              sourceThreadId: row.sourceThreadId,
              sourceItemId: row.sourceItemId,
              ...(messageId === undefined ? {} : { messageId }),
              position: row.position,
              source: threadFindItemSource(row.item),
              field,
              occurrence,
              excerpt,
            }),
          );
        };
        // Clients count what the wire sends them, so the server does too.
        collect(
          "text",
          threadFindItemText(projectTurnItemForWire(row.item)).text,
          THREAD_FIND_TEXT_EXCERPT,
        );
        const { detail } = threadFindItemText(row.item);
        if (detail !== undefined && matches.length < MATCH_LIMIT) {
          collect(
            "detail",
            detail.slice(0, DETAIL_SEARCH_CHARS),
            detail.length > DETAIL_SEARCH_CHARS
              ? { ...THREAD_FIND_DETAIL_EXCERPT, totalLength: detail.length }
              : THREAD_FIND_DETAIL_EXCERPT,
          );
        }
        return matches.length < MATCH_LIMIT;
      },
    );
    return { matches, truncated: matches.length >= MATCH_LIMIT || !scan.complete };
  });

  return ThreadFind.of({ find });
});

export const layer = Layer.effect(ThreadFind, make);
