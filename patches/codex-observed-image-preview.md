# Codex Observed Image Preview

## Why this patch exists

Codex can inspect local images through an `image_view` tool item. The upstream UI can show the inspected image back to the user, but T3 Code previously rendered that work-log item as text only.

This patch snapshots locally viewed image files into server-managed state and attaches image media metadata to the corresponding `thread.activity.append` payload. The web timeline renders those media entries as thumbnails and opens them with the existing expanded image viewer.

## Requirements

- Observed images must be served only through authenticated read-scoped HTTP requests.
- The UI should request observed media by stable storage id, not by the original local file path.
- Original local paths may be retained as diagnostic metadata in activity payloads but must not be used as browser URLs.
- Failed snapshotting must not break provider event ingestion; the text work-log row should still appear.

## Maintenance notes

- Keep the server route and storage helpers narrow to image media. Do not reuse this route for arbitrary tool artifacts without adding content-type and access semantics for those artifact types.
- If upstream adds a first-class artifact/media event model, prefer migrating this patch to that model instead of extending the `payload.media` convention further.
