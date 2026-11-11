# Codex observed-image previews

## Why this patch exists

Codex inspects local images with its `view_image` tool and reports each use as an `imageView`
item. Upstream maps that item to a `view_image` tool row with `viewedImagePath` (#30473), but its
preview loads the file as it is now. Agents often view a screenshot and then overwrite or delete
it, which leaves a wrong or broken preview.

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

`withObservedImage` in `apps/server/src/orchestration-v2/Adapters/CodexImageView.ts` takes the
`view_image` item upstream's adapter builds, labels it as a read of the image, and adds one optional
`observedImage` field. A new item type would have needed projection, wire, and client handling on
every surface.

Upstream-owned files with hooks:

- `packages/contracts/src/orchestrationV2.ts` adds the optional `observedImage` field to both
  `dynamic_tool` schemas, the domain one and the persisted JSON one.
- `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts` passes upstream's `imageView` item
  through `withObservedImage` in its `item/completed` handler.
- `apps/server/src/orchestration-v2/ProjectionStore.ts` adds `observedImage` ids to
  `getThreadAttachmentIds`. Thread deletion's
  `attachment.cleanup` effect then removes them.
- `packages/client-runtime/src/work-log/presentation.ts` adds `workEntryObservedImage` and
  `workEntriesViewedImages`, which gives upstream's viewed-images row each path's latest copy.
  `resolveViewedImageAsset` uses the copy when there is one.
- `apps/web/src/components/chat/TimelineWorkEntryRow.tsx` passes the copy to `resolveViewedImageAsset`
  in the expanded row and in upstream's `ViewedImagesTimelineRow` below a collapsed group
  (`viewedImagesRows` in `MessagesTimeline.logic.ts`).
- `apps/mobile/src/features/threads/thread-work-log.tsx` and `ThreadFeed.tsx` pass the copy through
  the viewed-image renderer. Mobile's viewed-images row gets it from `workEntriesViewedImages` in
  `lib/threadActivity.ts`.

The v1 patch also served local Markdown image paths through a `/local-image` route. Upstream now
signs those as `media-file` assets, so that part is gone.

## Providers

- Codex is supported.
- Claude reads images with its `Read` tool. Upstream previews them from the current file through
  `viewedImagePath`, and the fork takes no copy.
- Cursor, OpenCode, Grok, ACP agents, Pi, and Antigravity report no image-view item, so they are not
  supported.

## Removing this patch

Drop it when upstream keeps viewed images independent of later file changes. If upstream adds a first-class media model for turn items, move the copy onto it instead of
extending `observedImage`.
