import { EnvironmentId, type FollowUp, FollowUpId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildFollowUpGraph } from "./followUps.logic";

const followUp = (id: string, overrides: Partial<FollowUp> = {}): FollowUp => ({
  id: FollowUpId.make(id),
  title: id,
  body: "",
  status: "open",
  dueAt: null,
  condition: null,
  tags: [],
  links: [],
  type: null,
  fields: {},
  origin: null,
  pickedUpThread: null,
  result: null,
  mergedInto: null,
  returnedAt: null,
  createdBy: { kind: "agent", thread: null },
  createdAt: "2026-11-01T09:00:00.000Z",
  updatedAt: "2026-11-01T09:00:00.000Z",
  closedAt: null,
  ...overrides,
});

describe("buildFollowUpGraph", () => {
  const home = EnvironmentId.make("home");
  const ref = (id: string) => ({ environmentId: home, threadId: ThreadId.make(id) });
  const origin = (id: string, threadTitle: string | null) => ({
    ...ref(id),
    messageId: null,
    quote: null,
    threadTitle,
  });
  const followUps = [
    followUp("a", {
      origin: origin("t1", "Where it started"),
      pickedUpThread: ref("t2"),
      links: [
        { kind: "blocks", target: { type: "followUp", followUpId: FollowUpId.make("b") } },
        { kind: "see", target: { type: "thread", ...ref("t2") } },
        { kind: "after", target: { type: "followUp", followUpId: FollowUpId.make("gone") } },
      ],
    }),
    followUp("b", { origin: origin("t1", null) }),
    followUp("c", {
      status: "merged",
      mergedInto: FollowUpId.make("a"),
      links: [{ kind: "same as", target: { type: "followUp", followUpId: FollowUpId.make("b") } }],
    }),
  ];
  const shape = (showClosed: boolean) => {
    const graph = buildFollowUpGraph([{ environmentId: home, followUps }], showClosed);
    return {
      nodes: graph.nodes.map((node) =>
        node.kind === "thread" ? [node.key, node.recordedTitle] : [node.key],
      ),
      edges: graph.edges.map((edge) => [edge.from, edge.to, edge.labels]),
    };
  };

  it("joins open follow-ups to their threads and each other, one line per pair", () => {
    expect(shape(false)).toEqual({
      nodes: [
        ["thread:home:t1", "Where it started"],
        ["thread:home:t2", null],
        ["followUp:home:a"],
        ["followUp:home:b"],
      ],
      edges: [
        ["followUp:home:a", "thread:home:t1", ["came from"]],
        ["followUp:home:a", "thread:home:t2", ["picked up in", "see"]],
        ["followUp:home:a", "followUp:home:b", ["blocks"]],
        ["followUp:home:b", "thread:home:t1", ["came from"]],
      ],
    });
  });

  it("adds closed follow-ups and their relations only when shown", () => {
    expect(shape(true).edges.slice(-2)).toEqual([
      ["followUp:home:c", "followUp:home:a", ["merged into"]],
      ["followUp:home:c", "followUp:home:b", ["same as"]],
    ]);
  });

  it("keeps its shape through edits that move no node or edge, so the layout stays put", () => {
    const edited = followUps.map((entry) =>
      entry.id === "a" ? { ...entry, title: "Renamed", body: "More detail" } : entry,
    );
    const shapeOf = (list: ReadonlyArray<FollowUp>) =>
      buildFollowUpGraph([{ environmentId: home, followUps: list }], false).shape;
    expect(shapeOf(edited)).toBe(shapeOf(followUps));
    expect(shapeOf(followUps.slice(1))).not.toBe(shapeOf(followUps));
  });
});
