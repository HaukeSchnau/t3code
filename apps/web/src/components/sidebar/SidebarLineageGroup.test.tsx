import { buildThreadLineage, resolveSidebarLineage } from "@t3tools/client-runtime/state/threads";
import { EnvironmentId, ThreadId, ThreadOrchestrationEffortId } from "@t3tools/contracts";
import TestRenderer, { act, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

import { SidebarLineageGroup } from "./SidebarLineageGroup";

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
});

const environmentId = EnvironmentId.make("environment-1");
const threadId = (value: string) => ThreadId.make(value);
const key = (value: string) => `${environmentId}:${value}`;
const ref = (value: string) => ({ threadId: threadId(value) });

describe("SidebarLineageGroup", () => {
  it("labels unassigned children when the coordinator also has effort sections", async () => {
    const effortId = ThreadOrchestrationEffortId.make("effort-1");
    const lineage = buildThreadLineage([
      {
        environmentId,
        coordination: {
          relationships: [
            {
              kind: "createdBy",
              actor: ref("coordinator"),
              target: ref("member"),
              createdAt: "2026-09-03T08:00:00.000Z",
            },
            {
              kind: "createdBy",
              actor: ref("coordinator"),
              target: ref("unassigned"),
              createdAt: "2026-09-03T08:01:00.000Z",
            },
          ],
          efforts: [
            {
              effortId,
              coordinator: ref("coordinator"),
              title: "Current effort",
              members: [
                {
                  thread: ref("member"),
                  label: "Member",
                  joinedAt: "2026-09-03T08:00:00.000Z",
                },
              ],
              openedAt: "2026-09-03T08:00:00.000Z",
              closedAt: null,
            },
          ],
          waits: [],
        },
      },
    ]);
    const layout = resolveSidebarLineage(
      lineage,
      new Set([key("coordinator"), key("member"), key("unassigned")]),
    );
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <SidebarLineageGroup
          parentKey={key("coordinator")}
          lineage={lineage}
          layout={layout}
          renderRow={(threadKey) => <li data-thread-key={threadKey}>{threadKey}</li>}
          workerState={() => "working"}
          effortSummary={() => ({ label: "1 working", attention: false })}
        />,
      );
    });

    expect(
      renderer!.root.findByProps({ "data-testid": "sidebar-other-delegated-work-header" }).children,
    ).toEqual(["Other delegated work"]);
    expect(renderer!.root.findAllByProps({ "data-thread-key": key("unassigned") })).toHaveLength(1);
    await act(async () => renderer!.unmount());
  });
});
