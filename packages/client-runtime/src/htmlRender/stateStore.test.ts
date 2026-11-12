import type { EnvironmentId, HtmlRenderState, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { makeHtmlRenderStateStore, type HtmlRenderStateTarget } from "./stateStore.ts";

const target: HtmlRenderStateTarget = {
  environmentId: "env" as EnvironmentId,
  threadId: "thread" as ThreadId,
  renderId: "render",
};

function setup() {
  const writes: Array<{
    state: HtmlRenderState;
    resolve: (stored: boolean) => void;
  }> = [];
  const store = makeHtmlRenderStateStore({
    write: (_target, state) =>
      new Promise<boolean>((resolve) => {
        writes.push({ state, resolve });
      }),
  });
  return { store, writes };
}

describe("makeHtmlRenderStateStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes the last save at once when the last view leaves", () => {
    const { store, writes } = setup();
    const release = store.view(target);
    store.save(target, { n: "1" });
    store.save(target, { n: "2" });
    release();
    expect(writes.map((write) => write.state)).toEqual([{ n: "2" }]);
  });

  it("keeps a released save readable until its write lands", async () => {
    const { store, writes } = setup();
    store.view(target)();
    store.save(target, { n: "1" });
    vi.advanceTimersByTime(300);
    expect(store.read(target)).toEqual({ n: "1" });
    writes[0]?.resolve(true);
    await Promise.resolve();
    expect(store.read(target)).toBeUndefined();
  });

  it("sends a save made during a write only after that write lands", async () => {
    const { store, writes } = setup();
    const release = store.view(target);
    store.save(target, { n: "1" });
    vi.advanceTimersByTime(300);
    store.save(target, { n: "2" });
    release();
    expect(writes.map((write) => write.state)).toEqual([{ n: "1" }]);
    writes[0]?.resolve(true);
    await Promise.resolve();
    expect(writes.map((write) => write.state)).toEqual([{ n: "1" }, { n: "2" }]);
  });

  it("keeps a failed write and sends it with the next flush", async () => {
    const { store, writes } = setup();
    store.save(target, { n: "1" });
    vi.advanceTimersByTime(300);
    writes[0]?.resolve(false);
    await Promise.resolve();
    expect(store.read(target)).toEqual({ n: "1" });
    store.flush();
    expect(writes.map((write) => write.state)).toEqual([{ n: "1" }, { n: "1" }]);
  });
});
