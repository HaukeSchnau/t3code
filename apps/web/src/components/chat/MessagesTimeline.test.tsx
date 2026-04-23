import { EnvironmentId, MessageId, TurnId } from "@t3tools/contracts";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { LegendListRef } from "@legendapp/list/react";

vi.mock("@legendapp/list/react", async () => {
  const React = await import("react");

  const LegendList = React.forwardRef(function MockLegendList(
    props: {
      data: Array<{ id: string }>;
      keyExtractor: (item: { id: string }) => string;
      renderItem: (args: { item: { id: string } }) => React.ReactNode;
      ListHeaderComponent?: React.ReactNode;
      ListFooterComponent?: React.ReactNode;
    },
    _ref: React.ForwardedRef<LegendListRef>,
  ) {
    return (
      <div data-testid="legend-list">
        {props.ListHeaderComponent}
        {props.data.map((item) => (
          <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
        ))}
        {props.ListFooterComponent}
      </div>
    );
  });

  return { LegendList };
});

function matchMedia() {
  return {
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

beforeAll(() => {
  const classList = {
    add: () => {},
    remove: () => {},
    toggle: () => {},
    contains: () => false,
  };

  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  });
  vi.stubGlobal("window", {
    matchMedia,
    addEventListener: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
    cancelAnimationFrame: () => {},
    desktopBridge: undefined,
  });
  vi.stubGlobal("document", {
    documentElement: {
      classList,
      offsetHeight: 0,
    },
  });
});

const ACTIVE_THREAD_ENVIRONMENT_ID = EnvironmentId.make("environment-local");

function buildProps() {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    activeTurnId: null,
    activeTurnStartedAt: null,
    listRef: createRef<LegendListRef | null>(),
    completionDividerBeforeEntryId: null,
    completionSummary: null,
    turnDiffSummaryByAssistantMessageId: new Map(),
    routeThreadKey: "environment-local:thread-1",
    onOpenTurnDiff: () => {},
    revertTurnCountByUserMessageId: new Map(),
    onRevertUserMessage: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: ACTIVE_THREAD_ENVIRONMENT_ID,
    markdownCwd: undefined,
    resolvedTheme: "light" as const,
    timestampFormat: "locale" as const,
    workspaceRoot: undefined,
    onIsAtEndChange: () => {},
  };
}

describe("MessagesTimeline", () => {
  it("renders inline terminal labels with the composer chip UI", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.make("message-2"),
              role: "user",
              text: [
                "yoo what's @terminal-1:1-5 mean",
                "",
                "<terminal_context>",
                "- Terminal 1 lines 1-5:",
                "  1 | julius@mac effect-http-ws-cli % bun i",
                "  2 | bun install v1.3.9 (cf6cdbbb)",
                "</terminal_context>",
              ].join("\n"),
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Terminal 1 lines 1-5");
    expect(markup).toContain("lucide-terminal");
    expect(markup).toContain("yoo what&#x27;s ");
  }, 20_000);

  it("renders context compaction entries in the normal work log", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Context compacted",
              tone: "info",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Context compacted");
    expect(markup).toContain("Work log");
  });

  it("formats changed file paths from the workspace root", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Updated files",
              tone: "tool",
              changedFiles: ["C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts"],
            },
          },
        ]}
        workspaceRoot="C:/Users/mike/dev-stuff/t3code"
      />,
    );

    expect(markup).toContain("t3code/apps/web/src/session-logic.ts");
    expect(markup).not.toContain("C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts");
  });

  it("renders expanded Codex command details and keeps raw payload hidden by default", async () => {
    const { WorkEntryRow } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <WorkEntryRow
        workEntry={{
          id: "work-command",
          createdAt: "2026-03-17T19:12:28.000Z",
          label: "Ran command",
          tone: "tool",
          command: "bun run lint",
          toolTitle: "Ran command",
          toolStatus: "completed",
          turnId: TurnId.make("turn-command"),
          toolContext: {
            heading: "Ran command",
            parameters: [
              {
                label: "Command",
                value: "bun run lint",
                format: "code",
              },
              {
                label: "Working directory",
                value: "/Users/haukeschnau/OSS/t3code",
                format: "code",
              },
            ],
            outputs: [
              {
                label: "Output",
                value: "Checked 120 files\nAll good",
                format: "code",
              },
            ],
            fileChanges: [],
            rawPayload: {
              item: {
                type: "commandExecution",
                command: "bun run lint",
              },
            },
          },
        }}
        workspaceRoot="/Users/haukeschnau/OSS/t3code"
        onOpenTurnDiff={() => {}}
        defaultExpanded
      />,
    );

    expect(markup).toContain("Parameters");
    expect(markup).toContain("Working directory");
    expect(markup).toContain("Checked 120 files");
    expect(markup).toContain("Show raw payload");
    expect(markup).not.toContain('"type": "commandExecution"');
  });

  it("shows running commands inline with live duration and current output", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-17T19:12:38.000Z"));

    try {
      const { WorkEntryRow } = await import("./MessagesTimeline");
      const markup = renderToStaticMarkup(
        <WorkEntryRow
          workEntry={{
            id: "work-command-running",
            createdAt: "2026-03-17T19:12:28.000Z",
            label: "Tool updated",
            tone: "tool",
            itemType: "command_execution",
            command: "jj status",
            toolStatus: "running",
            toolContext: {
              heading: "Ran command",
              preview: "The working copy has no changes.",
              parameters: [
                {
                  label: "Command",
                  value: "jj status",
                  format: "code",
                },
              ],
              outputs: [
                {
                  label: "Output",
                  value: "The working copy has no changes.\nWorking copy  (@) : qp test",
                  format: "code",
                },
              ],
              fileChanges: [],
            },
          }}
          workspaceRoot="/Users/haukeschnau/OSS/t3code"
          onOpenTurnDiff={() => {}}
        />,
      );

      expect(markup).toContain("Ran command");
      expect(markup).toContain("Running");
      expect(markup).toContain("jj status");
      expect(markup).toContain("10s");
      expect(markup).toContain("The working copy has no changes.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows completed command duration without expanding", async () => {
    const { WorkEntryRow } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <WorkEntryRow
        workEntry={{
          id: "work-command-complete",
          createdAt: "2026-03-17T19:12:28.000Z",
          label: "Ran command",
          tone: "tool",
          itemType: "command_execution",
          command: "bun run lint",
          toolStatus: "completed",
          toolContext: {
            heading: "Ran command",
            parameters: [],
            outputs: [
              {
                label: "Duration",
                value: "1.5s",
                format: "text",
              },
            ],
            fileChanges: [],
          },
        }}
        workspaceRoot="/Users/haukeschnau/OSS/t3code"
        onOpenTurnDiff={() => {}}
      />,
    );

    expect(markup).toContain("Ran command");
    expect(markup).toContain("1.5s");
    expect(markup).toContain("tabular-nums");
  });

  it("renders failed tool status with stronger contrast styling", async () => {
    const { WorkEntryRow } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <WorkEntryRow
        workEntry={{
          id: "work-command-failed",
          createdAt: "2026-03-17T19:12:28.000Z",
          label: "Ran command",
          tone: "error",
          itemType: "command_execution",
          command: "playwriter execute",
          toolStatus: "failed",
          detail: "No Playwright pages are available.",
          toolContext: {
            heading: "Ran command",
            parameters: [],
            outputs: [],
            fileChanges: [],
          },
        }}
        workspaceRoot="/Users/haukeschnau/OSS/t3code"
        onOpenTurnDiff={() => {}}
      />,
    );

    expect(markup).toContain("Failed");
    expect(markup).toContain("text-rose-700");
  });

  it("renders Codex file-change detail rows with diff previews and full diff handoff", async () => {
    const { WorkEntryRow } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <WorkEntryRow
        workEntry={{
          id: "work-file-change",
          createdAt: "2026-03-17T19:12:28.000Z",
          label: "Edited files",
          tone: "tool",
          toolTitle: "Edited files",
          toolStatus: "completed",
          turnId: TurnId.make("turn-file-change"),
          changedFiles: ["/Users/haukeschnau/OSS/t3code/apps/web/src/session-logic.ts"],
          toolContext: {
            heading: "Edited files",
            parameters: [],
            outputs: [],
            fileChanges: [
              {
                path: "/Users/haukeschnau/OSS/t3code/apps/web/src/session-logic.ts",
                kind: "update",
                diff: "@@ -1,2 +1,3 @@\n old\n+new\n",
              },
            ],
            rawPayload: {
              item: {
                type: "fileChange",
              },
            },
          },
        }}
        workspaceRoot="/Users/haukeschnau/OSS/t3code"
        onOpenTurnDiff={() => {}}
        defaultExpanded
      />,
    );

    expect(markup).toContain("File changes");
    expect(markup).toContain("t3code/apps/web/src/session-logic.ts");
    expect(markup).toContain("Open full diff");
    expect(markup).toContain("diff-render-file");
    expect(markup).toContain(
      'data-diff-file-path="/Users/haukeschnau/OSS/t3code/apps/web/src/session-logic.ts"',
    );
  });

  it("does not render duplicate file pills for edited-file rows", async () => {
    const { WorkEntryRow } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <WorkEntryRow
        workEntry={{
          id: "work-file-row",
          createdAt: "2026-03-17T19:12:28.000Z",
          label: "Edited files",
          tone: "tool",
          itemType: "file_change",
          changedFiles: ["/Users/haukeschnau/OSS/t3code/apps/web/src/session-logic.test.ts"],
          toolContext: {
            heading: "Edited files",
            preview: "/Users/haukeschnau/OSS/t3code/apps/web/src/session-logic.test.ts",
            parameters: [],
            outputs: [],
            fileChanges: [
              {
                path: "/Users/haukeschnau/OSS/t3code/apps/web/src/session-logic.test.ts",
              },
            ],
          },
        }}
        workspaceRoot="/Users/haukeschnau/OSS/t3code"
        onOpenTurnDiff={() => {}}
      />,
    );

    expect(markup).not.toContain(
      "rounded-md border border-border/55 bg-background/75 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/75",
    );
  });

  it("shows raw payload only after the secondary disclosure is opened", async () => {
    const { WorkEntryRow } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <WorkEntryRow
        workEntry={{
          id: "work-raw-payload",
          createdAt: "2026-03-17T19:12:28.000Z",
          label: "search_code",
          tone: "tool",
          toolTitle: "search_code",
          toolStatus: "running",
          toolContext: {
            heading: "search_code",
            parameters: [
              {
                label: "Arguments",
                value: '{\n  "query": "deriveWorkLogEntries"\n}',
                format: "json",
              },
            ],
            outputs: [],
            fileChanges: [],
            rawPayload: {
              item: {
                type: "dynamicToolCall",
                tool: "search_code",
              },
            },
          },
        }}
        workspaceRoot="/Users/haukeschnau/OSS/t3code"
        onOpenTurnDiff={() => {}}
        defaultExpanded
        defaultRawPayloadExpanded
      />,
    );

    expect(markup).toContain("Hide raw payload");
    expect(markup).toContain("&quot;type&quot;: &quot;dynamicToolCall&quot;");
    expect(markup).toContain("&quot;tool&quot;: &quot;search_code&quot;");
  });

  it("keeps rows without structured tool detail compact and non-expandable", async () => {
    const { WorkEntryRow } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <WorkEntryRow
        workEntry={{
          id: "work-compact",
          createdAt: "2026-03-17T19:12:28.000Z",
          label: "Context compacted",
          tone: "info",
        }}
        workspaceRoot="/Users/haukeschnau/OSS/t3code"
        onOpenTurnDiff={() => {}}
      />,
    );

    expect(markup).toContain("Context compacted");
    expect(markup).not.toContain("Show tool details");
    expect(markup).not.toContain("Show raw payload");
  });
});
