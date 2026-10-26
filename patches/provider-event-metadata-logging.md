# Provider event metadata logging

## Why

Full payload logs amplified disk writes and energy use during long provider sessions on the
self-hosted servers. They also kept prompt and output text on disk.

## Requirement

Provider event logs must never hold payload values, must stay bounded per record, and must sample
high-frequency events. Upstream writes one log file per thread and keeps payloads of up to 64K
characters per record.

## Implementation

- Both streams write to one global file, upstream's `providerEventLogPath`
  (`logs/provider/events.log`), which `t3 triage` points agents at. Records keep their `NTIVE` or
  `CANON` label. Upstream opens a file per thread below that path. `apps/server/src/server.ts`
  builds the store unchanged (`layerProviderEventLoggers`).
- `apps/server/src/provider/ProviderEventMetadata.ts` reduces each event to bounded identity fields
  (event name, id, provider, provider instance and thread, turn, item), the body's value type, and
  a character, byte, item or field count. Payload values and payload key names never reach the
  record.
- `apps/server/src/provider/EventNdjsonLogger.ts` keeps upstream's `shouldPersistProviderEvent`
  filter at the top of `write`, so canonical deltas and progress, raw native frames, token deltas
  and running OpenCode tool snapshots never reach the file. It writes every remaining record to
  that one file and caps each encoded record at 1 KiB; an oversized record keeps every identity
  field clipped to 64 encoded bytes. A native event that still arrives at high frequency, such as
  an OpenCode `message.updated` or another provider's delta, keeps its first eight records per
  thread and event name and then every 256th, noting how many it skipped. Other events, such as
  lifecycle and error events, are never sampled. Rotation and retention keep upstream's defaults.
- The logger still exports upstream's `boundProviderEventForLogging`, and the orchestration v2
  adapters still call `shouldPersistProviderEvent` before handing an event to the logger. Keep
  those exports when upstream changes them.

## Removal

Retire this patch when upstream logs metadata only, or makes payload capture opt-in and bounded.

## Verification

`EventNdjsonLogger.test.ts` and `ProviderEventMetadata.test.ts`.
