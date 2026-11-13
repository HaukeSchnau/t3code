import {
  EnvironmentId,
  type FollowUp,
  FollowUpId,
  type FollowUpsSnapshot,
  type FollowUpStatus,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { createLinkedFollowUpAtomFamily, followUpHomes } from "./followUps.ts";

const srv2 = EnvironmentId.make("srv-2");
const tower = EnvironmentId.make("tower");
const devHauke = EnvironmentId.make("dev-hauke");

describe("followUpHomes", () => {
  it.each([
    {
      mode: "personal: every machine names srv-2",
      environments: [
        { environmentId: srv2, followUpHome: srv2 },
        { environmentId: tower, followUpHome: srv2 },
      ],
      homes: [{ environmentId: srv2, connected: true }],
    },
    {
      mode: "work: dev-hauke keeps its own",
      environments: [{ environmentId: devHauke, followUpHome: undefined }],
      homes: [{ environmentId: devHauke, connected: true }],
    },
    {
      mode: "all: both stores",
      environments: [
        { environmentId: tower, followUpHome: srv2 },
        { environmentId: srv2, followUpHome: srv2 },
        { environmentId: devHauke, followUpHome: devHauke },
      ],
      homes: [
        { environmentId: srv2, connected: true },
        { environmentId: devHauke, connected: true },
      ],
    },
    {
      mode: "custom: tower without its home",
      environments: [{ environmentId: tower, followUpHome: srv2 }],
      homes: [{ environmentId: srv2, connected: false }],
    },
  ])("$mode", ({ environments, homes }) => {
    expect(followUpHomes(environments)).toEqual(homes);
  });
});

describe("createLinkedFollowUpAtomFamily", () => {
  const followUp = (status: FollowUpStatus): FollowUp => ({
    id: FollowUpId.make("fu-1"),
    title: "Rotate the key",
    body: "",
    status,
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
    createdAt: "2026-11-13T00:00:00.000Z",
    updatedAt: "2026-11-13T00:00:00.000Z",
    closedAt: null,
  });
  type Result = AsyncResult.AsyncResult<FollowUpsSnapshot, Error>;
  const listing = (...followUps: ReadonlyArray<FollowUp>): Result =>
    AsyncResult.success({ followUps, types: [], lastGardenerRun: null });

  it.each<{
    readonly when: string;
    readonly connected: ReadonlyArray<EnvironmentId>;
    readonly open: Result;
    readonly closed: Result;
    readonly shows: unknown;
  }>([
    {
      when: "the open list has it",
      connected: [srv2],
      open: listing(followUp("open")),
      closed: AsyncResult.initial(true),
      shows: { state: "found", title: "Rotate the key", status: "open" },
    },
    {
      when: "only the closed list has it",
      connected: [srv2],
      open: listing(),
      closed: listing(followUp("done")),
      shows: { state: "found", title: "Rotate the key", status: "done" },
    },
    {
      when: "the closed list is on its way",
      connected: [srv2],
      open: listing(),
      closed: AsyncResult.initial(true),
      shows: { state: "loading" },
    },
    {
      when: "neither list has it",
      connected: [srv2],
      open: listing(),
      closed: listing(),
      shows: { state: "missing" },
    },
    {
      when: "its home cannot answer",
      connected: [srv2],
      open: AsyncResult.fail(new Error("no follow-ups here")),
      closed: AsyncResult.initial(true),
      shows: { state: "missing" },
    },
    {
      when: "its home is not connected",
      connected: [tower],
      open: listing(followUp("open")),
      closed: listing(),
      shows: { state: "missing" },
    },
  ])("shows a link as $shows.state when $when", ({ connected, open, closed, shows }) => {
    const openAtom = Atom.make(open);
    const closedAtom = Atom.make(closed);
    const linked = createLinkedFollowUpAtomFamily(
      ({ input }) => (input.includeClosed ? closedAtom : openAtom),
      Atom.make(connected),
    );
    expect(AtomRegistry.make().get(linked("t3-follow-up://srv-2/fu-1"))).toEqual(shows);
  });
});
