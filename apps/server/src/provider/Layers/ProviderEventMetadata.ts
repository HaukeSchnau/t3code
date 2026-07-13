export type ProviderEventMetadataStream = "native" | "canonical" | "orchestration";

const MAX_THREAD_ID_LENGTH = 128;
const MAX_EVENT_NAME_LENGTH = 160;
const MAX_IDENTITY_LENGTH = 128;
const MAX_PROVIDER_LENGTH = 64;

const HIGH_FREQUENCY_CANONICAL_EVENTS = new Set([
  "content.delta",
  "turn.proposed.delta",
  "thread.realtime.audio.delta",
  "item.updated",
  "task.progress",
  "hook.progress",
  "tool.progress",
]);

interface ProviderEventBodyMetadata {
  readonly valueType:
    | "missing"
    | "null"
    | "string"
    | "bytes"
    | "array"
    | "object"
    | "number"
    | "boolean"
    | "other";
  readonly characterCount?: number;
  readonly byteLength?: number;
  readonly itemCount?: number;
  readonly fieldCount?: number;
}

export interface ProviderEventMetadataRecord {
  readonly schemaVersion: 1;
  readonly stream: ProviderEventMetadataStream;
  readonly threadId: string | null;
  readonly event: {
    readonly name: string;
    readonly id?: string;
    readonly provider?: string;
    readonly providerInstanceId?: string;
    readonly providerThreadId?: string;
    readonly turnId?: string;
    readonly itemId?: string;
  };
  readonly body: ProviderEventBodyMetadata;
  readonly sampling?: {
    readonly occurrence: number;
    readonly suppressedSincePrevious: number;
  };
  readonly metadataTruncated?: true;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function eventName(record: Readonly<Record<string, unknown>>): string {
  return (
    boundedString(record.type, MAX_EVENT_NAME_LENGTH) ??
    boundedString(record.method, MAX_EVENT_NAME_LENGTH) ??
    boundedString(record.kind, MAX_EVENT_NAME_LENGTH) ??
    "unknown"
  );
}

function summarizeBody(value: unknown, present: boolean): ProviderEventBodyMetadata {
  if (!present) return { valueType: "missing" };
  if (value === null) return { valueType: "null" };
  if (typeof value === "string") {
    return { valueType: "string", characterCount: value.length };
  }
  if (value instanceof Uint8Array) {
    return { valueType: "bytes", byteLength: value.byteLength };
  }
  if (Array.isArray(value)) {
    return { valueType: "array", itemCount: value.length };
  }
  if (typeof value === "number") return { valueType: "number" };
  if (typeof value === "boolean") return { valueType: "boolean" };
  if (typeof value !== "object") return { valueType: "other" };

  try {
    const keys = Object.keys(value as object);
    return {
      valueType: "object",
      fieldCount: keys.length,
    };
  } catch {
    return { valueType: "object" };
  }
}

export function makeProviderEventMetadata(input: {
  readonly event: unknown;
  readonly stream: ProviderEventMetadataStream;
  readonly threadId: string | null;
  readonly sampling?: ProviderEventMetadataRecord["sampling"];
}): ProviderEventMetadataRecord {
  const root = asRecord(input.event) ?? {};
  const record = asRecord(root.event) ?? root;
  const hasPayload = Object.hasOwn(record, "payload");
  const hasMessage = !hasPayload && Object.hasOwn(record, "message");
  const body = hasPayload ? record.payload : hasMessage ? record.message : undefined;
  const id =
    boundedString(record.eventId, MAX_IDENTITY_LENGTH) ??
    boundedString(record.id, MAX_IDENTITY_LENGTH);
  const provider = boundedString(record.provider, MAX_PROVIDER_LENGTH);
  const providerInstanceId = boundedString(record.providerInstanceId, MAX_IDENTITY_LENGTH);
  const providerThreadId = boundedString(record.providerThreadId, MAX_IDENTITY_LENGTH);
  const turnId = boundedString(record.turnId, MAX_IDENTITY_LENGTH);
  const itemId = boundedString(record.itemId, MAX_IDENTITY_LENGTH);

  return {
    schemaVersion: 1,
    stream: input.stream,
    threadId: input.threadId === null ? null : input.threadId.slice(0, MAX_THREAD_ID_LENGTH),
    event: {
      name: eventName(record),
      ...(id ? { id } : {}),
      ...(provider ? { provider } : {}),
      ...(providerInstanceId ? { providerInstanceId } : {}),
      ...(providerThreadId ? { providerThreadId } : {}),
      ...(turnId ? { turnId } : {}),
      ...(itemId ? { itemId } : {}),
    },
    body: summarizeBody(body, hasPayload || hasMessage),
    ...(input.sampling ? { sampling: input.sampling } : {}),
  };
}

export function isHighFrequencyProviderEvent(
  stream: ProviderEventMetadataStream,
  name: string,
): boolean {
  if (stream === "canonical") return HIGH_FREQUENCY_CANONICAL_EVENTS.has(name);
  if (stream === "orchestration") return false;

  const normalized = name.toLowerCase();
  return (
    normalized === "protocol" ||
    normalized === "message.updated" ||
    normalized === "message.part.updated" ||
    normalized.includes("/stream_event/content_block_delta") ||
    normalized.endsWith("/outputdelta") ||
    normalized.endsWith("/delta") ||
    normalized.endsWith(".delta") ||
    normalized.endsWith("_delta")
  );
}
