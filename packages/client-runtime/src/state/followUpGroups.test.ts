import { type FollowUp, FollowUpId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { groupFollowUps } from "./followUps.ts";

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

describe("groupFollowUps", () => {
  const followUps = [
    followUp("undated-old", { createdAt: "2026-11-01T09:00:00.000Z" }),
    followUp("due-later", { dueAt: "2026-11-20T09:00:00.000Z" }),
    followUp("undated-new", { createdAt: "2026-11-05T09:00:00.000Z" }),
    followUp("due-soon", { dueAt: "2026-11-13T09:00:00.000Z" }),
    followUp("back", {
      dueAt: "2026-11-10T09:00:00.000Z",
      returnedAt: "2026-11-10T09:00:00.000Z",
    }),
    followUp("picked", { status: "picked_up", updatedAt: "2026-11-11T09:00:00.000Z" }),
    followUp("done", { status: "done", closedAt: "2026-11-09T09:00:00.000Z" }),
    followUp("dropped", { status: "dropped", closedAt: "2026-11-11T09:00:00.000Z" }),
  ];
  const groups = groupFollowUps(followUps);
  const ids = (group: ReadonlyArray<FollowUp>) => group.map((entry) => entry.id);

  it("lists what came back, then dated ones soonest first, then undated ones newest first", () => {
    expect(ids(groups.backNow)).toEqual(["back"]);
    expect(ids(groups.open)).toEqual(["due-soon", "due-later", "undated-new", "undated-old"]);
    expect(ids(groups.pickedUp)).toEqual(["picked"]);
  });

  it("lists closed ones latest closed first", () => {
    expect(ids(groups.closed)).toEqual(["dropped", "done"]);
  });
});
