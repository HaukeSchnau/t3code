# Thread find

Find in a thread merges two sources. Clients match the rows they have loaded, and the
server's `orchestration.findInThread` adds rows the client has not loaded plus `detail`, the
content the [wire projection](../../apps/server/src/orchestration-v2/WireProjection.ts) strips
(command output, diffs, tool I/O).

## A match is an occurrence, counted the same everywhere

A match is identified by its source thread, item, field, and occurrence, which is the nth match
of the query inside that field. Clients replace the server's `text` matches for loaded rows with their
own, so both sides must count identically. They do because both run the shared matcher in
[`packages/shared/src/threadFind.ts`](../../packages/shared/src/threadFind.ts) over the same
text. The server searches `text` after applying the wire projection, because that projection is
what clients received. Searching the raw item there would shift occurrences, for example in long
subagent output. Keep counting rules in the shared module.

## Regex stays on the client

The server never compiles a user pattern. Matching runs synchronously next to the single
SQLite connection, so a catastrophic pattern would stall every client of the environment.
Regex queries match only loaded rows, and the UI says so.

## Painting uses rendered text

The web client paints with the CSS Custom Highlight API over each row's rendered text instead of
mapping data offsets into the DOM. `threadFindMessageText` strips inline Markdown to approximate
what renders, but the two can still differ, so the painter re-matches inside the row, clamps the
occurrence to what it found, and falls back to the row itself.

## The selection does not move on its own

The cursor follows the match nearest the reader until they pick or step. After that, server
answers, history pages, and streaming only re-index it. Live follow pauses while find is open for
the same reason.
