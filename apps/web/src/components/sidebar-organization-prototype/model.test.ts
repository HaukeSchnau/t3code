import { describe, expect, it } from "vitest";

import { SAMPLE, type ProtoThread } from "./data";
import {
  buildIndex,
  coordinatorTray,
  countDescendants,
  countWork,
  isEffortCurrent,
  placeThread,
  topLevelThreads,
} from "./model";

const index = buildIndex(SAMPLE);

describe("coordinatorTray", () => {
  it("nests bare children when a coordinator has no efforts, hiding superseded attempts", () => {
    const tray = coordinatorTray(index, "c-casa");
    expect(tray?.sections).toHaveLength(0);
    expect(tray?.bare.map((t) => t.id)).toEqual([
      "casa-fable",
      "casa-opus",
      "casa-glm",
      "casa-sol-2",
      "casa-genova",
    ]);
  });

  it("keeps a closed effort in current work while a member is unsettled", () => {
    const tray = coordinatorTray(index, "c-orch");
    expect(tray?.sections.map((s) => s.containerId)).toEqual([
      "effort:e-rules",
      "effort:e-adapters",
      "other:c-orch",
    ]);
    expect(tray?.pastEfforts.map((e) => e.id)).toEqual(["e-orbit", "e-compare", "e-preview"]);
  });

  it("moves an effort to past efforts once every member has settled", () => {
    const settle = (t: ProtoThread) => (t.effortId === "e-adapters" ? { ...t, settled: true } : t);
    const settled = buildIndex({ threads: SAMPLE.threads.map(settle), efforts: SAMPLE.efforts });
    const adapters = SAMPLE.efforts.find((e) => e.id === "e-adapters")!;
    expect(isEffortCurrent(settled, adapters)).toBe(false);
    expect(coordinatorTray(settled, "c-orch")?.pastEfforts.map((e) => e.id)).toContain(
      "e-adapters",
    );
  });
});

describe("countWork", () => {
  it("counts recursively and treats failures and blocks as needs-you", () => {
    expect(countWork(index, ["c-orch"])).toEqual({ working: 3, needsYou: 3, done: 3 });
  });

  it("skips superseded attempts", () => {
    expect(countWork(index, ["c-casa"])).toEqual({ working: 3, needsYou: 1, done: 1 });
  });
});

describe("lineage roots", () => {
  it("lists two independent roots inside one project and counts hidden descendants", () => {
    const t3Roots = topLevelThreads(index)
      .filter((t) => t.project === "t3code")
      .map((t) => t.id);
    expect(t3Roots).toEqual(["t-usage", "c-orch", "t-codex"]);
    expect(countDescendants(index, "t-codex")).toBe(2);
    // Six current direct children plus two under the nested coordinator.
    expect(countDescendants(index, "c-orch")).toBe(9);
    expect(countDescendants(index, "t-usage")).toBe(0);
  });
});

describe("placeThread", () => {
  it("puts a section member behind its root tray and section", () => {
    expect(placeThread(index, "sol-rules")).toEqual({
      coordinatorId: "c-orch",
      containers: ["tray:c-orch", "effort:e-rules"],
    });
  });

  it("puts a superseded attempt behind its replacement", () => {
    expect(placeThread(index, "casa-sol-1")?.containers).toEqual([
      "tray:c-casa",
      "attempts:casa-sol-2",
    ]);
  });

  it("puts settled children on the settled shelf", () => {
    expect(placeThread(index, "orbit-fable")).toEqual({
      coordinatorId: null,
      containers: ["settled"],
    });
  });
});
