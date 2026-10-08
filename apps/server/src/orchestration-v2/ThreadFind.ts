import type {
  OrchestrationFindInThreadInput,
  OrchestrationFindInThreadResult,
  OrchestrationThreadFindField,
  OrchestrationThreadFindMatch,
} from "@t3tools/contracts";
import {
  compileThreadFind,
  findThreadMatches,
  threadFindExcerpts,
  threadFindItemSource,
  threadFindItemText,
} from "@t3tools/shared/threadFind";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "./ProjectionStore.ts";

const MATCH_LIMIT = 1000;
// Tool output can run to megabytes. Only its start is searched.
const DETAIL_SEARCH_CHARS = 256 * 1024;
// Bounds one find's time on the shared SQLite connection and event loop.
const SCAN_BUDGET_CHARS = 64 * 1024 * 1024;

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
    // Clients validate regex before sending, so an invalid one finds nothing.
    if (matcher?._tag !== "Valid") return { matches: [], truncated: false };

    const matches: Array<OrchestrationThreadFindMatch> = [];
    let scanned = 0;
    let truncated = false;
    yield* projections.scanTimeline(input.threadId, (rows) => {
      for (const row of rows) {
        const { text, detail } = threadFindItemText(row.item);
        const fields: Array<[OrchestrationThreadFindField, string, number | undefined]> = [
          ["text", text, undefined],
        ];
        if (detail !== undefined) {
          fields.push(
            detail.length > DETAIL_SEARCH_CHARS
              ? ["detail", detail.slice(0, DETAIL_SEARCH_CHARS), detail.length]
              : ["detail", detail, undefined],
          );
        }
        for (const [field, value, totalLength] of fields) {
          scanned += value.length;
          const ranges = findThreadMatches(matcher, value, MATCH_LIMIT - matches.length);
          threadFindExcerpts(value, ranges, totalLength).forEach((excerpt, occurrence) =>
            matches.push({
              sourceThreadId: row.sourceThreadId,
              sourceItemId: row.sourceItemId,
              position: row.position,
              source: threadFindItemSource(row.item),
              field,
              occurrence,
              excerpt,
            }),
          );
          if (matches.length >= MATCH_LIMIT || scanned >= SCAN_BUDGET_CHARS) {
            truncated = true;
            return false;
          }
        }
      }
      return true;
    });
    return { matches, truncated };
  });

  return ThreadFind.of({ find });
});

export const layer = Layer.effect(ThreadFind, make);
