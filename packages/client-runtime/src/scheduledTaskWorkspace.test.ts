import type { ScheduledTask } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  scheduledTaskWorkspaceChoice,
  scheduledTaskWorkspaceStrategy,
} from "./scheduledTaskWorkspace.ts";

describe("scheduledTaskWorkspaceStrategy", () => {
  it.each<ScheduledTask["workspaceStrategy"]>([
    { type: "workspace", isolated: true, profile: "minimal" },
    { type: "workspace", baseRef: "release", startFromOrigin: true, isolated: false },
    { type: "worktree", baseRef: "release" },
    { type: "root", branch: "feature" },
    { type: "existing_worktree", worktreePath: "/tmp/checkout", branch: "feature" },
  ])("saves %j unchanged when the form leaves it alone", (saved) => {
    expect(scheduledTaskWorkspaceStrategy(scheduledTaskWorkspaceChoice(saved), saved)).toEqual(
      saved,
    );
  });

  it("keeps a managed workspace's isolation when only the base changes", () => {
    const saved = { type: "workspace", isolated: true, profile: "familiar" } as const;
    expect(
      scheduledTaskWorkspaceStrategy(
        { ...scheduledTaskWorkspaceChoice(saved), baseRef: "release" },
        saved,
      ),
    ).toEqual({ ...saved, baseRef: "release", startFromOrigin: false });
  });

  it("follows a changed workspace choice", () => {
    const saved = { type: "workspace", isolated: true } as const;
    expect(
      scheduledTaskWorkspaceStrategy(
        { ...scheduledTaskWorkspaceChoice(saved), mode: "root" },
        saved,
      ),
    ).toEqual({ type: "root" });
  });
});
