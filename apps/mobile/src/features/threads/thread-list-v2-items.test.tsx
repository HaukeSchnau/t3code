import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

import { ThreadListV2OrchestrationRow, ThreadListV2Row } from "./thread-list-v2-items";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  Platform: { select: (choices: { default?: unknown }) => choices.default },
  Pressable: "Pressable",
  View: "View",
  useWindowDimensions: () => ({ height: 1_024, width: 768 }),
}));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: "SymbolView" }));
vi.mock("../../components/AppText", () => ({ AppText: "Text" }));
vi.mock("../../components/ControlPill", () => ({ ControlPillMenu: "ControlPillMenu" }));
vi.mock("../../components/EnvironmentMachineSymbol", () => ({
  EnvironmentMachineSymbol: "EnvironmentMachineSymbol",
}));
vi.mock("../../components/ProjectFavicon", () => ({ ProjectFavicon: "ProjectFavicon" }));
vi.mock("../../components/ProviderIcon", () => ({ ProviderIcon: "ProviderIcon" }));
vi.mock("../../lib/useUniwindTheme", () => ({
  useUniwindTheme: () => ({
    "--color-drawer": "transparent",
    "--color-screen": "transparent",
    "--color-subtle": "transparent",
    "--color-user-bubble": "transparent",
  }),
}));
vi.mock("../../state/use-thread-pr", () => ({ useThreadPr: () => null }));
vi.mock("../home/thread-swipe-actions", async () => {
  const React = await import("react");
  return {
    ThreadSwipeable: (props: { children: (close: () => void) => React.ReactNode }) =>
      React.createElement(React.Fragment, null, props.children(vi.fn())),
  };
});
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "light" }),
}));
vi.mock("./thread-search-match", () => ({ ThreadSearchMatchExcerpt: "ThreadSearchMatchExcerpt" }));

const environmentId = EnvironmentId.make("environment-1");
const NOW = "2026-09-03T12:00:00.000Z";

function thread(): EnvironmentThreadShell {
  return {
    environmentId,
    id: ThreadId.make("root"),
    projectId: ProjectId.make("project-1"),
    title: "Coordinator",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

function rowProps() {
  const noop = vi.fn();
  return {
    thread: thread(),
    variant: "card" as const,
    snoozePresetMinute: NOW,
    project: null,
    providerDriver: null,
    environmentLabel: null,
    onSelectThread: noop,
    onDeleteThread: noop,
    onRegenerateThreadTitle: noop,
    onSettleThread: noop,
    onSnoozeThread: noop,
    onUnsnoozeThread: noop,
    onUnsettleThread: noop,
    onArchiveThread: noop,
    onPinThread: noop,
    onUnpinThread: noop,
    settlementSupported: true,
    snoozeSupported: false,
    pinningSupported: true,
    titleRegenerationSupported: true,
    onSwipeableWillOpen: noop,
    onSwipeableClose: noop,
  };
}

describe("native orchestration rows", () => {
  it("exposes expanded state for root, nested, and retry disclosures", () => {
    let root: ReactTestRenderer;
    act(() => {
      root = create(
        <ThreadListV2Row
          {...rowProps()}
          orchestration={{
            type: "thread",
            key: "thread:root",
            threadKey: `${environmentId}:root`,
            rootKey: `${environmentId}:root`,
            depth: 0,
            lineageContainer: {
              id: "lineage:root",
              expanded: false,
              summary: "1 working · 1 hidden",
              attention: false,
              root: true,
            },
            attemptsContainer: { id: "attempts:root", expanded: true, count: 1 },
          }}
        />,
      );
    });
    expect(
      root!.root.findByProps({ accessibilityLabel: "1 earlier attempts" }).props.accessibilityState,
    ).toEqual({ expanded: true });
    expect(
      root!.root.findByProps({ accessibilityLabel: "Show delegated work for Coordinator" }).props
        .accessibilityState,
    ).toEqual({ expanded: false });
    act(() => root!.unmount());

    let nested: ReactTestRenderer;
    act(() => {
      nested = create(
        <ThreadListV2Row
          {...rowProps()}
          orchestration={{
            type: "thread",
            key: "thread:nested",
            threadKey: `${environmentId}:root`,
            rootKey: `${environmentId}:parent`,
            depth: 1,
            lineageContainer: {
              id: "lineage:nested",
              expanded: true,
              summary: "1 hidden",
              attention: false,
              root: false,
            },
            attemptsContainer: null,
          }}
        />,
      );
    });
    expect(
      nested!.root.findByProps({ accessibilityLabel: "Hide delegated work for Coordinator" }).props
        .accessibilityState,
    ).toEqual({ expanded: true });
    act(() => nested!.unmount());
  });

  it("renders a closed effort badge alongside its live summary", () => {
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(
        <ThreadListV2OrchestrationRow
          item={{
            type: "section",
            key: "section:closed",
            containerId: "effort:closed",
            rootKey: `${environmentId}:root`,
            depth: 1,
            title: "Closed effort",
            expanded: true,
            summary: "1 needs you · 2 hidden",
            attention: true,
            muted: false,
            closed: true,
          }}
          onToggle={vi.fn()}
          onReveal={vi.fn()}
        />,
      );
    });

    const labels = renderer!.root
      .findAll((node) => node.children.some((child) => typeof child === "string"))
      .map((node) => node.children.join(""));
    expect(labels).toEqual(
      expect.arrayContaining(["Closed effort", "Closed", "1 needs you · 2 hidden"]),
    );
    expect(
      renderer!.root.findAll((node) => node.props.accessibilityState?.expanded === true),
    ).toHaveLength(1);
    act(() => renderer!.unmount());
  });
});
