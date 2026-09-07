import {
  ProviderTurnId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  isTransportTruncatedText,
  isTurnItemDetailTruncated,
  TRANSPORT_TRUNCATION_SUFFIX,
} from "./turnItemHydration.ts";

const now = DateTime.makeUnsafe("2026-09-07T00:00:00.000Z");
const threadId = ThreadId.make("thread-1");
const providerTurnId = ProviderTurnId.make("provider-turn-1");

function base(id: string) {
  return {
    id: TurnItemId.make(id),
    threadId,
    runId: RunId.make("run-1"),
    nodeId: null,
    providerThreadId: null,
    providerTurnId,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  } as const;
}

describe("turn item hydration preview detection", () => {
  it("recognizes server-truncated text and keeps complete text untouched", () => {
    expect(isTransportTruncatedText(`prefix${TRANSPORT_TRUNCATION_SUFFIX}`)).toBe(true);
    expect(isTransportTruncatedText("complete output")).toBe(false);
  });

  it("covers every detail shape projected by the transport truncator", () => {
    const command = {
      ...base("command"),
      type: "command_execution" as const,
      input: "cat output",
      output: `prefix${TRANSPORT_TRUNCATION_SUFFIX}`,
    };
    const file = {
      ...base("file"),
      type: "file_change" as const,
      fileName: "README.md",
      diffStr: `diff${TRANSPORT_TRUNCATION_SUFFIX}`,
    };
    const subagent = {
      ...base("subagent"),
      type: "subagent" as const,
      subagentId: "node-1" as never,
      origin: "app_owned" as const,
      driver: "codex" as never,
      providerInstanceId: "codex" as never,
      childThreadId: null,
      prompt: "prompt",
      result: `result${TRANSPORT_TRUNCATION_SUFFIX}`,
    };
    const dynamicTool = {
      ...base("dynamic"),
      type: "dynamic_tool" as const,
      toolName: "tool",
      input: { summary: "preview", truncated: true },
    };

    expect(isTurnItemDetailTruncated(command)).toBe(true);
    expect(isTurnItemDetailTruncated(file)).toBe(true);
    expect(isTurnItemDetailTruncated(subagent)).toBe(true);
    expect(isTurnItemDetailTruncated(dynamicTool)).toBe(true);
    expect(
      isTurnItemDetailTruncated({
        ...command,
        output: "complete output",
      }),
    ).toBe(false);
  });
});
