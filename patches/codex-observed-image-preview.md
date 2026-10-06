# Codex observed-image previews

## Why this patch exists

Codex inspects local images with its `view_image` tool and reports each use as an `imageView`
item. Upstream's Codex adapter drops that item, so the timeline never shows what the agent looked
at. Upstream does preview images that Claude reads, but that preview loads the file as it is now.
Agents often view a screenshot and then overwrite or delete it, which leaves a wrong or broken
preview.

## Requirements

- An `imageView` item appears in the timeline as a read of that image. Expanding the row shows a
  thumbnail on web, desktop, and mobile. Selecting it opens the expanded image viewer.
- The thumbnail shows the image as Codex saw it. The server copies the file when the item
  completes, so later edits or deletion of the original leave the preview unchanged.
- Only previewable image types up to the 10 MiB image attachment limit are copied. A failed copy
  logs a warning and never blocks event ingestion. The row then falls back to upstream's preview of
  the current file.
- Agents in separate projects report paths from their own namespace. The copy resolves them through
  the agent-exec registry, like other media reads.
- Clients load the copy through a short-lived signed URL issued over the authenticated connection.
  A browser cannot attach bearer or DPoP credentials to an `<img>` request, so this is what makes
  remote and relay clients work.
- Deleting the thread deletes the copy.

## Implementation

The copy is a thread-owned image attachment. `apps/server/src/observedImageSnapshot.ts` writes it to
the attachments directory under a deterministic id built from the thread id and a SHA-256 of the
bytes, so repeated views of one image share a file. As an attachment it gets upstream's signed
`attachment` asset URL and upstream's attachment cleanup on thread deletion. The v1 fork needed its
own `observed-media` directory, asset resource, and HTTP route for this. V2 needs none of them.

`apps/server/src/orchestration-v2/Adapters/CodexImageView.ts` maps `imageView` onto a `dynamic_tool`
item named `view_image`. Upstream already uses `dynamic_tool` with `viewedImagePath` for Claude's
image reads, so grouping, labels, and the expanded image rendering work unchanged. The fork adds one
optional `observedImage` field to that item. A new item type would have needed projection, wire,
and client handling on every surface.

Upstream-owned files with hooks:

- `packages/contracts/src/orchestrationV2.ts` adds the optional `observedImage` field to both
  `dynamic_tool` schemas, the domain one and the persisted JSON one.
- `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts` handles `imageView` in its
  `item/completed` handler.
- `apps/server/src/orchestration-v2/ProjectionStore.ts` adds `observedImage` ids to
  `getThreadAttachmentIds` in the SQLite and in-memory stores. Thread deletion's
  `attachment.cleanup` effect then removes them.
- `packages/client-runtime/src/work-log/presentation.ts` adds `workEntryObservedImage`.
  `resolveViewedImageAsset` uses the copy when there is one.
- `apps/web/src/components/chat/MessagesTimeline.tsx` passes the copy to `resolveViewedImageAsset`.
- `apps/mobile/src/features/threads/thread-work-log.tsx` and `ThreadFeed.tsx` pass the copy through
  the viewed-image renderer.

The v1 patch also served local Markdown image paths through a `/local-image` route. Upstream now
signs those as `media-file` assets, so that part is gone.

## Providers

- Codex is supported.
- Claude reads images with its `Read` tool. Upstream previews them from the current file through
  `viewedImagePath`, and the fork takes no copy.
- Cursor, OpenCode, Grok, ACP agents, Pi, and Antigravity report no image-view item, so they are not
  supported.

## Removing this patch

Drop it when upstream maps Codex `imageView` items and keeps viewed images independent of later file
changes. If upstream adds a first-class media model for turn items, move the copy onto it instead of
extending `observedImage`.
