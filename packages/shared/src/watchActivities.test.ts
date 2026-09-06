import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { collapseWatchActivities } from "./watchActivities.ts";

function activity(kind: string, payload: unknown): OrchestrationThreadActivity {
  return {
    id: EventId.make(kind),
    kind,
    payload,
    summary: kind,
    tone: "info",
    turnId: null,
    createdAt: "2026-09-06T13:00:00Z",
  };
}

it("keeps diagnostics out of chat and preserves one stable lifecycle row per watch", () => {
  const opened = activity("thread-orchestration.watch.opened", { watch: { watchId: "a" } });
  const diagnostic = activity("thread-orchestration.watch.event", {
    watchId: "a",
    decision: "ignore",
  });
  const started = activity("thread-orchestration.watch.started", { watchId: "a" });
  const other = activity("tool.completed", {});
  const second = activity("thread-orchestration.watch.opened", { watch: { watchId: "b" } });
  const closed = activity("thread-orchestration.watch.closed", { watchId: "a" });
  const history = [opened, diagnostic, started, other, second];
  const active = collapseWatchActivities(history);
  expect(active).toHaveLength(3);
  expect(active[0]?.summary).toBe("Watching for changes");
  const finished = collapseWatchActivities([...history, closed]);
  expect(finished).toHaveLength(3);
  expect(finished[0]).toMatchObject({ id: opened.id, summary: closed.summary });
  expect(finished[1]).toBe(other);
  expect(history[1]).toBe(diagnostic);
});
