import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import TestRenderer, { act, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  SidebarCardThreadsProvider,
  usePublishSidebarCardThreads,
  useSidebarCardThreads,
} from "./SidebarCardThreadsContext";

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
});

const NO_THREADS: readonly EnvironmentThreadShell[] = [];

function Publisher() {
  usePublishSidebarCardThreads(NO_THREADS);
  return null;
}

function Consumer() {
  const threads = useSidebarCardThreads();
  return <span>{threads === null ? "unavailable" : threads.length}</span>;
}

function Harness({ publish }: { publish: boolean }) {
  return (
    <SidebarCardThreadsProvider>
      {publish ? <Publisher /> : null}
      <Consumer />
    </SidebarCardThreadsProvider>
  );
}

describe("SidebarCardThreadsContext", () => {
  it("shares the sidebar card set and clears it when the publisher unmounts", async () => {
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<Harness publish />);
    });
    expect(renderer!.root.findByType("span").children).toEqual(["0"]);

    await act(async () => {
      renderer!.update(<Harness publish={false} />);
    });
    expect(renderer!.root.findByType("span").children).toEqual(["unavailable"]);

    await act(async () => renderer!.unmount());
  });
});
