import TestRenderer, { act, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

import { SidebarOrchestrationSectionRow, SidebarViewingRow } from "./SidebarLineageGroup";

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
});

describe("sidebar orchestration rows", () => {
  it("toggles compact effort headers", async () => {
    const onToggle = vi.fn();
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <SidebarOrchestrationSectionRow
          item={{
            type: "section",
            key: "section:effort-1",
            containerId: "effort:effort-1",
            rootKey: "env:root",
            depth: 1,
            title: "Implementation",
            expanded: false,
            summary: "1 needs you · 2 hidden",
            attention: true,
            muted: false,
            closed: false,
          }}
          onToggle={onToggle}
        />,
      );
    });

    await act(async () => renderer!.root.findByType("button").props.onClick());
    expect(onToggle).toHaveBeenCalledWith("effort:effort-1");
    await act(async () => renderer!.unmount());
  });

  it("shows a closed current effort and its live summary independently", async () => {
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <SidebarOrchestrationSectionRow
          item={{
            type: "section",
            key: "section:effort-closed",
            containerId: "effort:effort-closed",
            rootKey: "env:root",
            depth: 1,
            title: "Finished coordination",
            expanded: true,
            summary: "1 needs you · 2 hidden",
            attention: true,
            muted: false,
            closed: true,
          }}
          onToggle={vi.fn()}
        />,
      );
    });

    const labels = renderer!.root.findAllByType("span").map((node) => node.children.join(""));
    expect(labels).toEqual(
      expect.arrayContaining(["Finished coordination", "Closed", "1 needs you · 2 hidden"]),
    );
    await act(async () => renderer!.unmount());
  });

  it("reveals the selected thread's complete container path", async () => {
    const onReveal = vi.fn();
    const containerIds = ["lineage:root", "effort:one", "lineage:nested"];
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <SidebarViewingRow
          item={{
            type: "viewing",
            key: "viewing:child",
            rootKey: "root",
            threadKey: "child",
            depth: 1,
            containerIds,
          }}
          title="Selected child"
          onReveal={onReveal}
        />,
      );
    });

    await act(async () => renderer!.root.findByType("button").props.onClick());
    expect(onReveal).toHaveBeenCalledWith(containerIds);
    await act(async () => renderer!.unmount());
  });
});
