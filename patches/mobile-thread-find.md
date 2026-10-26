# Mobile thread find

## Requirement

Find in thread works on iOS and Android, not only on web and desktop. It shows a find bar in the
composer's place with the match count, steps to the previous and next match, and scrolls the feed
to the current one. Cmd+F opens find while a thread is in front, and Android has a Find action in
the thread header. Thread search hits from the thread list and the command palette use upstream's
open-at-message jump (`threadMessageJump.ts`) and do not open find.

## Why upstream does not cover it

Upstream ships find on web and desktop only (`chat.find`, `ThreadFindBar` and `useThreadFind` in
`apps/web`). The server half, `orchestration.searchThread` in `orchestration-v2/ThreadFind.ts`, is
client-neutral, so mobile uses it as is and adds no server code.

## Implementation

- `apps/mobile/src/features/threads/use-thread-find.ts` sends the query, the reader's place
  (`start`) and step offsets to `searchThread` through `orchestrationEnvironment.threadFind`. The
  server counts in user messages, assistant messages and plans, and stepping wraps there. The hook
  keeps the last answer while the next one loads and recounts 300 ms after the thread's content
  changes, without moving the reader.
- `thread-find-feed.ts` maps feed rows to the server's entry ids (message id for messages, item id
  for plans) and works out which run fold, work group and plan row hide a match. `ThreadFeed.tsx`
  opens those folds while find is open, keeps them open when find closes, pages in older history
  until an unloaded match arrives (at most 20 pages), and scrolls the row into view. It places a
  match in a long message by its position in the text. The revealed folds go into upstream's
  `useThreadFeedPresentation`, and `findActive` keeps end-follow and end maintenance off.
- Rendered Markdown cannot carry marks: `react-native-enriched-markdown` has no range highlight
  API, and its `==highlight==` syntax has one colour and skips code. Find therefore marks matches
  only in plain text, which today means an expanded plan row (`ThreadFindText` in
  `thread-find-highlight.tsx`).
- `ThreadRouteScreen.tsx` owns whether find is open and registers Cmd+F (`focusSearch`) while the
  screen is focused. `ThreadDetailScreen.tsx` renders `ThreadFindBar.tsx` in the composer slot and closes find before
  any path that focuses the composer. Android Back closes find first.
- The thread header shows a Find button: `useThreadHeaderOptions.tsx` on iOS, `ThreadGitControls.tsx`
  in the fallback toolbar, and `ThreadHeader.tsx` on Android. `ThreadRouteScreen.tsx` passes
  `onOpenFind` through upstream's `ThreadScreenBinding` header; the draft header has no Find.
- `ThreadNavigationSidebar.tsx` registers its Cmd+F handler once, so toggling the sidebar does not
  take the shortcut from an open thread.

## Removal

Drop this patch when upstream ships find in the mobile app.

## Verification

`thread-find-feed.test.ts` covers fold reveal and the starting entry. After a sync, on a device:
type a query in a long thread, step through matches across a collapsed run and into unloaded
history, open a thread from a thread search hit (it should land on the message without find), and
press Cmd+F on an iPad keyboard with the sidebar open.
