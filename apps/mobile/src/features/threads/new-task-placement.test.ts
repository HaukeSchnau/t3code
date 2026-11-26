import { EnvironmentId, type PlacementPreview } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  newTaskLaunchesHere,
  newTaskPlacementLabel,
  resolveNewTaskPlacement,
} from "./new-task-placement";

const devHauke: PlacementPreview = {
  environmentId: EnvironmentId.make("dev-hauke"),
  label: "dev-hauke",
  reason: "3 free agent slots",
  wait: false,
  candidates: [],
};
const answered = (preview: PlacementPreview | null) => ({
  data: { preview },
  isPending: false,
  error: null,
});
const draft = {
  preview: answered(devHauke),
  environmentSelection: undefined,
  worktreePath: null,
  launchesHere: false,
  server: { hasAttachments: false, hasContext: false, branchesFromLocalCommit: false },
} as const;

describe("resolveNewTaskPlacement", () => {
  it("starts a new task on Auto until a machine is picked, as the web composer does", () => {
    expect(resolveNewTaskPlacement(draft)).toMatchObject({ available: true, automatic: true });
    expect(resolveNewTaskPlacement({ ...draft, environmentSelection: "auto" }).automatic).toBe(
      true,
    );
    expect(resolveNewTaskPlacement({ ...draft, environmentSelection: "manual" })).toMatchObject({
      available: true,
      automatic: false,
    });
  });

  it("keeps Auto while the preview is unanswered and drops it when no machine takes the task", () => {
    expect(
      resolveNewTaskPlacement({ ...draft, preview: { data: null, isPending: true, error: null } })
        .automatic,
    ).toBe(true);
    expect(
      resolveNewTaskPlacement({
        ...draft,
        preview: { data: null, isPending: false, error: "offline" },
      }).automatic,
    ).toBe(true);
    expect(resolveNewTaskPlacement({ ...draft, preview: answered(null) })).toMatchObject({
      available: false,
      automatic: false,
    });
  });

  it("never places a local task that continues another worktree", () => {
    expect(
      resolveNewTaskPlacement({ ...draft, worktreePath: "/repo/.t3/worktrees/feature" }).automatic,
    ).toBe(false);
  });

  it("says when the task stays on its machine, for the client's reasons and the server's", () => {
    expect(resolveNewTaskPlacement(draft).staysHere).toBe(false);
    expect(resolveNewTaskPlacement({ ...draft, launchesHere: true }).staysHere).toBe(true);
    for (const reason of ["hasAttachments", "hasContext", "branchesFromLocalCommit"] as const) {
      expect(
        resolveNewTaskPlacement({ ...draft, server: { ...draft.server, [reason]: true } })
          .staysHere,
      ).toBe(true);
    }
  });
});

describe("newTaskLaunchesHere", () => {
  it("keeps triage, a pull request checkout and chosen repositories on this machine", () => {
    const plain = {
      isTriage: false,
      workspaceMode: "worktree",
      pullRequestReference: undefined,
      choosesRepositories: false,
    } as const;
    expect(newTaskLaunchesHere(plain)).toBe(false);
    expect(newTaskLaunchesHere({ ...plain, isTriage: true })).toBe(true);
    expect(
      newTaskLaunchesHere({
        ...plain,
        pullRequestReference: "https://github.com/acme/repo/pull/1",
      }),
    ).toBe(true);
    expect(newTaskLaunchesHere({ ...plain, choosesRepositories: true })).toBe(true);
  });
});

describe("newTaskPlacementLabel", () => {
  const label = (preview: PlacementPreview | null, staysHere = false) =>
    newTaskPlacementLabel({ available: true, automatic: true, staysHere, preview }, "tower");

  it("names where Auto would start the task", () => {
    expect(label(devHauke)).toBe("Auto → dev-hauke");
    expect(label({ ...devHauke, wait: true })).toBe("Auto → dev-hauke (waits for room)");
    expect(label(devHauke, true)).toBe("Auto → tower (stays here)");
    expect(label(null)).toBe("Auto");
  });
});
