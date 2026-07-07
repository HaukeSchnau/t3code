import { expect, it } from "@effect/vitest";

import {
  CODEX_THREAD_BRIDGE_APP_SERVER_ARGS,
  codexTrailingTurnCountAfter,
  codexThreadForkParams,
  codexThreadMessages,
  codexThreadTimestamp,
  codexThreadTitle,
  pathBasename,
} from "./CodexThreadBridge.ts";

it("uses release-compatible helper Codex app-server args", () => {
  expect(CODEX_THREAD_BRIDGE_APP_SERVER_ARGS).toEqual(["app-server"]);
});

it("derives Codex thread titles from explicit names, previews, or cwd", () => {
  expect(
    codexThreadTitle({
      name: "  Named thread  ",
      preview: "Preview",
      cwd: "/repo/project",
    }),
  ).toBe("Named thread");
  expect(
    codexThreadTitle({
      name: null,
      preview: `${"x".repeat(90)}`,
      cwd: "/repo/project",
    }),
  ).toBe("x".repeat(80));
  expect(
    codexThreadTitle({
      name: "",
      preview: "   ",
      cwd: "/repo/project/",
    }),
  ).toBe("project");
  expect(pathBasename("C:\\repo\\project\\")).toBe("project");
});

it("maps Codex thread turns into imported orchestration messages", () => {
  const importedAt = "2026-01-01T00:00:00.000Z";
  const messages = codexThreadMessages({
    importedAt,
    thread: {
      id: "codex-thread-1",
      turns: [
        {
          id: "turn-1",
          startedAt: 1_767_225_600,
          status: "completed",
          items: [
            {
              id: "user-1",
              type: "userMessage",
              content: [
                { type: "text", text: "Review this" },
                { type: "mention", name: "src/index.ts", path: "/repo/src/index.ts" },
                { type: "skill", name: "code-review", path: "/skills/code-review/SKILL.md" },
                { type: "image", url: "file:///tmp/image.png" },
              ],
            },
            {
              id: "assistant-1",
              type: "agentMessage",
              text: "Looks good.",
            },
            {
              id: "assistant-empty",
              type: "agentMessage",
              text: "   ",
            },
          ],
        },
      ],
    },
  });

  expect(messages).toEqual([
    {
      id: "codex:codex-thread-1:turn-1:user-1",
      role: "user",
      text: "Review this\n@src/index.ts\n$code-review",
      turnId: null,
      streaming: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "codex:codex-thread-1:turn-1:assistant-1",
      role: "assistant",
      text: "Looks good.",
      turnId: "turn-1",
      streaming: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ]);
});

it("does not import Codex turns after a retained T3 provider turn boundary", () => {
  const messages = codexThreadMessages({
    importedAt: "2026-01-01T00:00:00.000Z",
    importThroughTurnId: "turn-retained",
    thread: {
      id: "codex-thread-1",
      turns: [
        {
          id: "turn-retained",
          startedAt: 1_767_225_600,
          status: "completed",
          items: [
            {
              id: "assistant-retained",
              type: "agentMessage",
              text: "Retained answer.",
            },
          ],
        },
        {
          id: "turn-pruned-provider-only",
          startedAt: 1_767_225_700,
          status: "completed",
          items: [
            {
              id: "user-pruned",
              type: "userMessage",
              content: [{ type: "text", text: "Pruned request" }],
            },
            {
              id: "assistant-pruned",
              type: "agentMessage",
              text: "This should not come back.",
            },
          ],
        },
      ],
    },
  });

  expect(messages.map((message) => message.id)).toEqual([
    "codex:codex-thread-1:turn-retained:assistant-retained",
  ]);
});

it("imports no provider messages for an existing T3 thread with no retained provider turn", () => {
  const messages = codexThreadMessages({
    importedAt: "2026-01-01T00:00:00.000Z",
    importThroughTurnId: null,
    thread: {
      id: "codex-thread-1",
      turns: [
        {
          id: "turn-provider-only",
          startedAt: 1_767_225_600,
          status: "completed",
          items: [
            {
              id: "assistant-provider-only",
              type: "agentMessage",
              text: "Provider-only answer.",
            },
          ],
        },
      ],
    },
  });

  expect(messages).toEqual([]);
});

it("imports no provider messages when an existing T3 boundary is absent from Codex history", () => {
  const messages = codexThreadMessages({
    importedAt: "2026-01-01T00:00:00.000Z",
    importThroughTurnId: "turn-retained-locally",
    thread: {
      id: "codex-thread-1",
      turns: [
        {
          id: "turn-provider-only",
          startedAt: 1_767_225_600,
          status: "completed",
          items: [
            {
              id: "assistant-provider-only",
              type: "agentMessage",
              text: "Provider-only answer.",
            },
          ],
        },
      ],
    },
  });

  expect(messages).toEqual([]);
});

it("falls back for invalid Codex timestamps", () => {
  expect(codexThreadTimestamp(null, "fallback")).toBe("fallback");
  expect(codexThreadTimestamp(Number.NaN, "fallback")).toBe("fallback");
});

it("passes optional fork turn bounds and destination context to Codex app-server", () => {
  expect(
    codexThreadForkParams({
      providerThreadId: "codex-thread-1",
      cwd: "/repo",
      lastTurnId: "turn-2",
      developerInstructions: "Use the destination workspace as authoritative.",
    }),
  ).toEqual({
    threadId: "codex-thread-1",
    cwd: "/repo",
    lastTurnId: "turn-2",
    developerInstructions: "Use the destination workspace as authoritative.",
  });

  expect(
    codexThreadForkParams({
      providerThreadId: "codex-thread-1",
      lastTurnId: null,
    }),
  ).toEqual({
    threadId: "codex-thread-1",
  });
});

it("counts fork turns that need compatibility rollback after a turn boundary", () => {
  const turns = [{ id: "turn-1" }, { id: "turn-2" }, { id: "turn-3" }];

  expect(codexTrailingTurnCountAfter(turns, "turn-2")).toBe(1);
  expect(codexTrailingTurnCountAfter(turns, "turn-3")).toBe(0);
  expect(codexTrailingTurnCountAfter(turns, "missing")).toBe(0);
  expect(codexTrailingTurnCountAfter(turns, null)).toBe(0);
});
