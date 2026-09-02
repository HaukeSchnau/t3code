import { describe, expect, it } from "vitest";
import { EnvironmentId } from "@t3tools/contracts";
import {
  buildThreadLineage,
  groupChildrenByEffort,
  openWaitsOf,
  resolveSidebarLineage,
} from "@t3tools/client-runtime/state/threads";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  FIXTURE_ENVIRONMENT_ID,
  buildFixtureCoordination,
  buildFixtureShellSnapshot,
  fixtureShellSnapshotAtom,
  fixtureThreadKey,
  withFixtureCatalog,
  withFixtureSnapshot,
} from "./fixtureEnvironment";
import { reduceFixtureEvents } from "./reducer";
import { COORDINATOR_ID, EFFORT_AUTH, FIXTURE_STEPS } from "./scenario";

const END_STATE = reduceFixtureEvents(FIXTURE_STEPS.flatMap((step) => step.events));

describe("fixture shell snapshot", () => {
  it("presents every fixture thread as a canonical shell with live status fields", () => {
    const snapshot = buildFixtureShellSnapshot(END_STATE);
    expect(snapshot.projects.map((project) => project.title)).toEqual(["t3code", "infra"]);
    const byId = new Map(snapshot.threads.map((thread) => [thread.id, thread]));
    const coordinator = byId.get(COORDINATOR_ID as never);
    expect(coordinator?.pinnedAt).not.toBeNull();
    // Idle behind open waits reads as Monitoring in the real sidebar.
    expect(coordinator?.backgroundLiveness).toBe("monitoring");
    expect(coordinator?.session?.status).toBe("ready");
    const reviewer = byId.get("thread-auth-rev-b" as never);
    expect(reviewer?.session?.status).toBe("running");
    expect(reviewer?.planProgress?.step).toBe("Checking the pairing cookie window");
    const failed = byId.get("thread-auth-impl" as never);
    expect(failed?.session?.status).toBe("error");
  });

  it("marks a blocked child through the pending-approval flag rather than a custom status", () => {
    const blockedStep = FIXTURE_STEPS.findIndex((step) =>
      step.caption.startsWith("The retry blocks"),
    );
    const state = reduceFixtureEvents(
      FIXTURE_STEPS.slice(0, blockedStep + 1).flatMap((step) => step.events),
    );
    const retry = buildFixtureShellSnapshot(state).threads.find(
      (thread) => thread.id === ("thread-auth-impl-retry" as never),
    );
    expect(retry?.hasPendingApprovals).toBe(true);
    expect(retry?.session?.status).toBe("running");
  });
});

describe("fixture coordination", () => {
  const coordination = buildFixtureCoordination(END_STATE);
  const lineage = buildThreadLineage([{ environmentId: FIXTURE_ENVIRONMENT_ID, coordination }]);

  it("publishes createdBy and replaces relationships the production lineage understands", () => {
    const coordinator = lineage.entries.get(fixtureThreadKey(COORDINATOR_ID));
    expect(coordinator?.parentKey).toBeNull();
    expect(coordinator?.childKeys).toContain(fixtureThreadKey("thread-auth-research"));
    expect(lineage.entries.get(fixtureThreadKey("thread-auth-research"))).toMatchObject({
      parentKey: fixtureThreadKey(COORDINATOR_ID),
      label: "Research",
      effortId: EFFORT_AUTH,
    });
    expect(lineage.entries.get(fixtureThreadKey("thread-auth-impl"))?.replacedByKey).toBe(
      fixtureThreadKey("thread-auth-impl-retry"),
    );
    // Grandchildren nest under the worker that spawned them.
    expect(lineage.entries.get(fixtureThreadKey("thread-docs-page-remote"))?.parentKey).toBe(
      fixtureThreadKey("thread-docs-content"),
    );
  });

  it("groups the coordinator's children by effort in opening order, then ungrouped", () => {
    const coordinatorKey = fixtureThreadKey(COORDINATOR_ID);
    const groups = groupChildrenByEffort(
      lineage,
      coordinatorKey,
      lineage.entries.get(coordinatorKey)?.childKeys ?? [],
    );
    expect(groups.map((group) => group.effort?.title ?? null)).toEqual([
      "Checkpoint flake",
      "Auth migration",
      "Docs site refresh",
      "Naming debate",
      null,
    ]);
    expect(groups.at(-1)?.memberKeys).toEqual([fixtureThreadKey("thread-ghostty")]);
  });

  it("keeps open waits with member outcomes", () => {
    const waits = openWaitsOf(lineage, fixtureThreadKey(COORDINATOR_ID));
    expect(waits.map((wait) => wait.waitId).sort()).toEqual(["wait-docs", "wait-review"]);
    const review = waits.find((wait) => wait.waitId === ("wait-review" as never));
    expect(review?.members.map((member) => member.outcome)).toEqual(["completed", "running"]);
  });

  it("nests every delegated thread in the sidebar while its parent is visible", () => {
    const visible = new Set(END_STATE.threadOrder.map(fixtureThreadKey));
    const layout = resolveSidebarLineage(lineage, visible);
    expect(layout.nestedKeys.has(fixtureThreadKey("thread-auth-research"))).toBe(true);
    expect(layout.nestedKeys.has(fixtureThreadKey("thread-tooltip"))).toBe(false);
    expect(layout.nestedKeys.has(fixtureThreadKey(COORDINATOR_ID))).toBe(false);
  });
});

describe("virtual environment atoms", () => {
  it("adds the fixture entry to the catalog only while a snapshot is published", () => {
    const registry = AtomRegistry.make();
    const baseCatalog = Atom.make({ isReady: true, entries: new Map() });
    const catalog = withFixtureCatalog(baseCatalog);
    expect(registry.get(catalog).entries.has(FIXTURE_ENVIRONMENT_ID)).toBe(false);
    registry.set(fixtureShellSnapshotAtom, buildFixtureShellSnapshot(END_STATE));
    expect(registry.get(catalog).entries.get(FIXTURE_ENVIRONMENT_ID)?.target.label).toBe("Fixture");
  });

  it("routes only the fixture id to the fixture snapshot", () => {
    const registry = AtomRegistry.make();
    const other = EnvironmentId.make("primary");
    const baseSnapshot = Atom.family((_id: EnvironmentId) => Atom.make(null));
    const snapshot = withFixtureSnapshot(baseSnapshot);
    registry.set(fixtureShellSnapshotAtom, buildFixtureShellSnapshot(END_STATE));
    expect(registry.get(snapshot(FIXTURE_ENVIRONMENT_ID))?.coordination?.efforts.length).toBe(4);
    expect(registry.get(snapshot(other))).toBeNull();
  });
});
