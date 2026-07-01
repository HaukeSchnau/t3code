import { expect, it } from "@effect/vitest";

import {
  codexThreadMessages,
  codexThreadTimestamp,
  codexThreadTitle,
  pathBasename,
} from "./CodexThreadBridge.ts";

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

it("falls back for invalid Codex timestamps", () => {
  expect(codexThreadTimestamp(null, "fallback")).toBe("fallback");
  expect(codexThreadTimestamp(Number.NaN, "fallback")).toBe("fallback");
});
