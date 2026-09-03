import { describe, expect, it } from "vitest";

import { SAMPLE, type ProtoThread } from "./data";
import {
  buildIndex,
  coordinatorTray,
  countGroup,
  countWork,
  isEffortCurrent,
  placeThread,
  projectGroups,
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

describe("projectGroups", () => {
  it("owns settled children through their root's project and rolls counts up recursively", () => {
    const t3 = projectGroups(index).find((g) => g.project === "t3code")!;
    expect(t3.roots.map((t) => t.id)).toEqual(["t-usage", "c-orch", "t-codex"]);
    expect(t3.settled.map((t) => t.id)).toContain("orbit-fable");
    // t-usage working + c-orch working + its 3 working descendants; 3 needs-you below c-orch.
    expect(countGroup(index, t3)).toEqual({ threads: 3, working: 5, needsYou: 3, done: 3 });
  });
});

describe("placeThread", () => {
  it("puts a section member behind its project, tray and section", () => {
    expect(placeThread(index, "sol-rules")).toEqual({
      coordinatorId: "c-orch",
      containers: ["project:t3code", "tray:c-orch", "effort:e-rules"],
    });
  });

  it("puts a superseded attempt behind its replacement", () => {
    expect(placeThread(index, "casa-sol-1")?.containers).toEqual([
      "project:casa",
      "tray:c-casa",
      "attempts:casa-sol-2",
    ]);
  });

  it("puts settled children on their project's settled shelf", () => {
    expect(placeThread(index, "orbit-fable")).toEqual({
      coordinatorId: null,
      containers: ["project:t3code", "settled:t3code"],
    });
  });
});
