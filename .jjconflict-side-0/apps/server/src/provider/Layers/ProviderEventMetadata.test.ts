import { assert, describe, it } from "@effect/vitest";

import {
  isHighFrequencyProviderEvent,
  makeProviderEventMetadata,
} from "./ProviderEventMetadata.ts";

describe("ProviderEventMetadata", () => {
  it("retains bounded identity metadata without payload values", () => {
    const secret = "secret-provider-payload";
    const secretKey = "authorization-Bearer-secret-key";
    const metadata = makeProviderEventMetadata({
      stream: "canonical",
      threadId: "thread-1",
      event: {
        type: "content.delta",
        eventId: "event-1",
        provider: "codex",
        providerInstanceId: "codex-work",
        providerThreadId: "provider-thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        payload: { delta: secret, streamKind: "command_output", [secretKey]: true },
      },
    });

    assert.deepEqual(metadata, {
      schemaVersion: 1,
      stream: "canonical",
      threadId: "thread-1",
      event: {
        name: "content.delta",
        id: "event-1",
        provider: "codex",
        providerInstanceId: "codex-work",
        providerThreadId: "provider-thread-1",
        turnId: "turn-1",
        itemId: "item-1",
      },
      body: {
        valueType: "object",
        fieldCount: 3,
      },
    });
    assert.notInclude(JSON.stringify(metadata), secret);
    assert.notInclude(JSON.stringify(metadata), secretKey);
  });

  it("unwraps native records and summarizes giant string messages by length", () => {
    const message = "x".repeat(2_000_000);
    const metadata = makeProviderEventMetadata({
      stream: "native",
      threadId: "thread-2",
      event: {
        observedAt: "2026-07-13T00:00:00.000Z",
        event: {
          id: "native-1",
          method: "process/stderr",
          message,
        },
      },
    });

    assert.equal(metadata.event.name, "process/stderr");
    assert.deepEqual(metadata.body, { valueType: "string", characterCount: message.length });
    assert.isBelow(JSON.stringify(metadata).length, 512);
  });

  it("classifies only known high-frequency provider event families", () => {
    assert.isTrue(isHighFrequencyProviderEvent("canonical", "content.delta"));
    assert.isTrue(isHighFrequencyProviderEvent("native", "item/commandExecution/outputDelta"));
    assert.isTrue(
      isHighFrequencyProviderEvent("native", "claude/stream_event/content_block_delta/text_delta"),
    );
    assert.isTrue(isHighFrequencyProviderEvent("native", "message.part.updated"));
    assert.isFalse(isHighFrequencyProviderEvent("canonical", "turn.completed"));
    assert.isFalse(isHighFrequencyProviderEvent("native", "request.opened"));
  });
});
