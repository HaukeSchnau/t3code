# Provider event metadata logging

## Why

Full payload logs amplified disk writes and energy use during long provider sessions on the
self-hosted servers. They also kept prompt and output text on disk.

## Requirement

Provider event logs must never hold payload values, must stay bounded per record, and must sample
high-frequency events. Upstream writes one log file per thread and keeps payloads of up to 64K
characters per record.

## Implementation

- `provider/Layers/ProviderEventLoggers.ts` opens one global file per stream, `native.log` and
  `canonical.log`, in the provider logs directory. Upstream opens a file per thread.
- `provider/Layers/ProviderEventMetadata.ts` reduces each event to bounded identity fields (event
  name, id, provider, provider instance and thread, turn, item), the body's value type, and a
  character, byte, item or field count. Payload values and payload key names never reach the
  record.
- `provider/Layers/EventNdjsonLogger.ts` caps each encoded record at 1 KiB. A high-frequency event,
  such as a delta or progress update, keeps its first eight records per thread and event name and
  then every 256th, noting how many it skipped. Other events, such as lifecycle and error events,
  are never sampled. Rotation and retention keep upstream's defaults.
- The logger still exports upstream's `shouldPersistProviderEvent` and
  `boundProviderEventForLogging`, because the orchestration v2 adapters call them before handing an
  event to the logger. Keep those exports when upstream changes them.

## Removal

Retire this patch when upstream logs metadata only, or makes payload capture opt-in and bounded.

## Verification

`EventNdjsonLogger.test.ts` and `ProviderEventMetadata.test.ts`.
