import { describe, expect, it, vi } from "vitest";
import { Outlet } from "@tanstack/react-router";
import { Children, isValidElement, type ReactNode } from "react";

import { DiffWorkerPoolProvider } from "../components/DiffWorkerPoolProvider";
import { ChatRouteLayout } from "./_chat";

vi.mock("../components/DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children: ReactNode }) => children,
}));

describe("ChatRouteLayout", () => {
  it("owns one persistent diff worker pool around routed chat content", () => {
    const layout = ChatRouteLayout();
    const children = Children.toArray(layout.props.children);
    const workerPools = children.filter(
      (child) =>
        isValidElement<{ children: ReactNode }>(child) && child.type === DiffWorkerPoolProvider,
    );

    expect(workerPools).toHaveLength(1);
    const [workerPool] = workerPools;
    expect(isValidElement<{ children: ReactNode }>(workerPool)).toBe(true);
    if (!isValidElement<{ children: ReactNode }>(workerPool)) return;

    const outlet = Children.only(workerPool.props.children);
    expect(isValidElement(outlet)).toBe(true);
    if (!isValidElement(outlet)) return;
    expect(outlet.type).toBe(Outlet);
  });
});
