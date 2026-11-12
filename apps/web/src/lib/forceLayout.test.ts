import { describe, expect, it } from "vite-plus/test";

import { forceLayout } from "./forceLayout";

const distance = (layout: ReturnType<typeof forceLayout>, from: string, to: string): number => {
  const a = layout.positions.get(from)!;
  const b = layout.positions.get(to)!;
  return Math.hypot(a.x - b.x, a.y - b.y);
};

describe("forceLayout", () => {
  const nodes = ["hub", "a", "b", "c", "d", "lone-1", "lone-2", "lone-3", "pair-1", "pair-2"];
  const edges: ReadonlyArray<readonly [string, string]> = [
    ["hub", "a"],
    ["hub", "b"],
    ["hub", "c"],
    ["c", "d"],
    ["pair-1", "pair-2"],
  ];

  it("places the same graph the same way whatever order it arrives in", () => {
    const layout = forceLayout({ nodes, edges });
    const shuffled = forceLayout({
      nodes: nodes.toReversed(),
      edges: edges.map(([from, to]) => [to, from] as const).toReversed(),
    });
    expect([...shuffled.positions].toSorted()).toEqual([...layout.positions].toSorted());
    expect(layout.positions.size).toBe(nodes.length);
    for (const point of layout.positions.values()) {
      expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
    }
  });

  it("ends linked nodes closer together than unlinked ones", () => {
    const layout = forceLayout({ nodes, edges });
    const linked = edges.map(([from, to]) => distance(layout, from, to));
    const unlinked = nodes.flatMap((from, index) =>
      nodes
        .slice(index + 1)
        .filter((to) => !edges.some((edge) => edge.includes(from) && edge.includes(to)))
        .map((to) => distance(layout, from, to)),
    );
    const mean = (values: ReadonlyArray<number>) =>
      values.reduce((sum, value) => sum + value, 0) / values.length;
    expect(Math.max(...linked)).toBeLessThan(mean(unlinked));
    expect(mean(linked)).toBeLessThan(mean(unlinked) / 2);
  });
});
