import {
  EnvironmentId,
  type OrchestrationProjectShell,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildThreadGlance, buildThreadGlanceList, glanceExcerpt } from "./threadGlance.ts";

const environmentId = EnvironmentId.make("srv-2");
const project = { id: ProjectId.make("project-1"), title: "t3code" } as OrchestrationProjectShell;
const now = Date.parse("2026-10-01T12:00:00.000Z");

// Only the fields the awareness projection reads.
const thread = (
  id: string,
  state: "running" | "completed" | "question" | "idle",
  overrides: Partial<OrchestrationThreadShell> = {},
) =>
  ({
    id: ThreadId.make(id),
    projectId: project.id,
    title: id,
    modelSelection: { provider: "codex", model: "gpt-5.5" },
    updatedAt: "2026-10-01T11:00:00.000Z",
    archivedAt: null,
    settledAt: null,
    session: state === "running" || state === "question" ? { status: "running" } : null,
    latestTurn: state === "completed" ? { state: "completed", completedAt: "x" } : null,
    hasPendingApprovals: false,
    hasPendingUserInput: state === "question",
    ...overrides,
  }) as OrchestrationThreadShell;

describe("buildThreadGlanceList", () => {
  it("puts threads that need the user first and keeps work in flight", () => {
    const list = buildThreadGlanceList({
      environmentId,
      snapshot: {
        projects: [project],
        threads: [
          thread("done", "completed"),
          thread("working", "running"),
          thread("asking", "question"),
          thread("never-started", "idle"),
        ],
      },
      nowMs: now,
    });

    expect(list.threads.map((row) => [row.threadId, row.phase])).toEqual([
      ["asking", "waiting_for_input"],
      ["working", "running"],
      ["done", "completed"],
    ]);
  });

  it("drops archived threads and finished ones that are settled or more than a day old", () => {
    const list = buildThreadGlanceList({
      environmentId,
      snapshot: {
        projects: [project],
        threads: [
          thread("archived", "running", { archivedAt: "2026-10-01T10:00:00.000Z" }),
          thread("settled", "completed", { settledAt: "2026-10-01T11:30:00.000Z" }),
          thread("yesterday", "completed", { updatedAt: "2026-09-30T11:00:00.000Z" }),
          thread("today", "completed"),
        ],
      },
      nowMs: now,
    });

    expect(list.threads.map((row) => row.threadId)).toEqual(["today"]);
  });
});

describe("buildThreadGlance", () => {
  const question = {
    kind: "user-input.requested",
    payload: {
      requestId: "request-1",
      questions: [
        {
          id: "runner",
          header: "Runner",
          question: "Which runner?",
          options: [
            { label: "Vitest", description: "" },
            { label: "Bun test", description: "" },
          ],
        },
      ],
    },
  } as OrchestrationThreadActivity;

  it("offers a simple pending question with its options, and Stop", () => {
    expect(
      buildThreadGlance({
        environmentId,
        project,
        thread: thread("asking", "question"),
        messages: [{ role: "assistant", text: "Which **runner** should I use?" }],
        openRequests: [question],
      }),
    ).toMatchObject({
      phase: "waiting_for_input",
      excerpt: "Which runner should I use?",
      question: { text: "Which runner?", options: ["Vitest", "Bun test"], allowsFreeText: true },
      canStop: true,
    });
  });

  it("has nothing to stop once the agent finished", () => {
    const glance = buildThreadGlance({
      environmentId,
      project,
      thread: thread("done", "completed"),
      messages: [],
      openRequests: [],
    });

    expect(glance).toMatchObject({ phase: "completed", canStop: false });
    expect(glance).not.toHaveProperty("question");
    expect(glance).not.toHaveProperty("excerpt");
  });
});

describe("glanceExcerpt", () => {
  it("reads Markdown as plain text and skips code", () => {
    expect(
      glanceExcerpt(
        "## Fixed\n\n- Moved `retry` into **auth**\n\n```ts\nconst x = 1;\n```\nSee [the PR](https://x).",
      ),
    ).toBe("Fixed Moved retry into auth See the PR.");
  });

  it("cuts long messages at a word boundary", () => {
    const excerpt = glanceExcerpt(`${"word ".repeat(100)}end`, 40);
    expect(excerpt).toBe("word word word word word word word word…");
  });
});
