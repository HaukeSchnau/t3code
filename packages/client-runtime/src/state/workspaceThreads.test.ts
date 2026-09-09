import { describe, expect, it } from "vitest";
import { ThreadWorkspaceId } from "@t3tools/contracts";
import { filterWorkspaceGroups, groupThreadsByWorkspace } from "./workspaceThreads";

const thread = (id: string, extra: Partial<ReturnType<typeof base>> = {}) => ({
  ...base(id),
  ...extra,
});
function base(id: string): {
  id: string;
  environmentId: string;
  projectId: string;
  workspaceId: ThreadWorkspaceId;
  worktreePath: string | null;
  branch: string;
  archivedAt: string | null;
  settled: boolean;
  session: { status: string } | null;
} {
  return {
    id,
    environmentId: "host",
    projectId: "project",
    workspaceId: ThreadWorkspaceId.make("workspace:first"),
    worktreePath: "/workspaces/fix-login",
    branch: "main",
    archivedAt: null,
    settled: false,
    session: null,
  };
}
const groups = (threads: ReturnType<typeof thread>[]) =>
  groupThreadsByWorkspace(threads, (entry) => entry.settled);
const visible = (threads: ReturnType<typeof thread>[]) =>
  filterWorkspaceGroups(groups(threads), { query: "", showSettled: false });

describe("workspace thread lifecycle", () => {
  it("stays visible until the last conversation settles and returns with new work", () => {
    const first = thread("first", { settled: true });
    expect(visible([first, thread("follow-up")])).toHaveLength(1);
    expect(visible([first, thread("follow-up", { settled: true })])).toEqual([]);
    expect(visible([first, thread("fresh-context")])).toHaveLength(1);
    expect(visible([thread("reopened")])).toHaveLength(1);
  });
  it("makes settled and archived work discoverable without changing their state", () => {
    const parked = thread("parked", { archivedAt: "2026-09-09T12:00:00Z" });
    const grouped = groups([parked]);
    expect(filterWorkspaceGroups(grouped, { query: "", showSettled: true })).toHaveLength(1);
    expect(filterWorkspaceGroups(grouped, { query: "login", showSettled: false })).toHaveLength(1);
    expect(grouped[0]?.settled).toBe(true);
    expect(parked.archivedAt).toBe("2026-09-09T12:00:00Z");
  });
  it("keeps running work visible even if a stale settlement projection arrives", () => {
    const grouped = groups([thread("running", { settled: true, session: { status: "running" } })]);
    expect(grouped[0]?.runningCount).toBe(1);
    expect(grouped[0]?.settled).toBe(false);
  });
  it("groups legacy duplicate records by checkout but keeps hosts and projects apart", () => {
    const grouped = groups([
      thread("first"),
      thread("legacy", { workspaceId: ThreadWorkspaceId.make("workspace:legacy") }),
      thread("remote", { environmentId: "remote" }),
      thread("other-project", { projectId: "other" }),
      thread("local", { worktreePath: null }),
    ]);
    expect(grouped).toHaveLength(3);
    expect(grouped[0]?.threads.map((entry) => entry.id)).toEqual(["first", "legacy"]);
  });
});
