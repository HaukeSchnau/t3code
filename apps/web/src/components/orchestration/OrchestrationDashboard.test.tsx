/**
 * The dashboard's job is to not lie. These render the real sample snapshot
 * through the real adapter and assert the specific things a batch dashboard
 * usually smooths over: a failed arm, a blocked arm, a shared checkout, and a
 * barrier that gave up while a worker kept going.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("../ui/scroll-area", () => ({ ScrollArea: "div" }));
vi.mock("../ui/sidebar", () => ({ SidebarInset: "div" }));
vi.mock("../ui/select", () => ({
  Select: "div",
  SelectItem: "div",
  SelectPopup: "div",
  SelectTrigger: "div",
  SelectValue: "div",
}));
vi.mock("../ui/toggle-group", () => ({ Toggle: "button", ToggleGroup: "div" }));
vi.mock("../WorkspaceBreadcrumb", () => ({
  WorkspaceBreadcrumb: "div",
  WorkspaceBreadcrumbItem: "div",
  WorkspaceBreadcrumbSeparator: "span",
}));
vi.mock("../WorkspacePageContainer", () => ({ WorkspacePageContainer: "main" }));
vi.mock("../WorkspacePageHeader", () => ({ WorkspacePageHeader: "header" }));

const { OrchestrationDashboard } = await import("./OrchestrationDashboard");
const { OrchestrationGraphView } = await import("./OrchestrationGraphView");
const { buildSampleOrchestrationSnapshot } = await import("../../orchestration/sampleData");
const { deriveBatchViews } = await import("../../orchestration/model");

const NOW = Date.parse("2026-08-31T12:00:00.000Z");
const snapshot = buildSampleOrchestrationSnapshot(NOW);
const batches = deriveBatchViews(snapshot.batches, NOW);

const dashboardMarkup = renderToStaticMarkup(
  <OrchestrationDashboard now={NOW} snapshot={snapshot} />,
);

describe("OrchestrationDashboard", () => {
  it("summarises the fleet including the work that needs a person", () => {
    expect(dashboardMarkup).toContain("13 workers in 4 batches");
    expect(dashboardMarkup).toContain("1 blocked");
  });

  it("keeps a failed arm in the roster instead of shortening the list", () => {
    expect(dashboardMarkup).toContain("Rewrite the session layer, no constraints");
    expect(dashboardMarkup).toContain("Failed");
  });

  it("states why a blocked arm is stuck rather than calling it busy", () => {
    expect(dashboardMarkup).toContain("Fix flaky tests in apps/server");
    expect(dashboardMarkup).toContain("Waiting on an approval");
  });

  it("flags an arm that shares another thread's checkout", () => {
    expect(dashboardMarkup).toContain("shared checkout");
  });

  it("reports a worker still running under a barrier that gave up", () => {
    // The release audit's remote arm outlived its deadline. The barrier says it
    // gave up; the roster must still say the worker is running.
    expect(dashboardMarkup).toContain("Timed out · 1 of 3 never reported");
    expect(dashboardMarkup).toContain("Audit the mobile release");
  });

  it("offers comparison only once a batch has settled", () => {
    expect(dashboardMarkup).toContain("Compare arms");
    expect(dashboardMarkup).toContain("Compare when settled");
  });
});

describe("OrchestrationGraphView", () => {
  const graphMarkup = renderToStaticMarkup(
    <OrchestrationGraphView
      batches={batches}
      onCompare={() => {}}
      onSelectNode={() => {}}
      selectedNodeId={null}
      snapshot={snapshot}
    />,
  );

  it("draws a thread that is both worker and coordinator exactly once", () => {
    const occurrences = graphMarkup.split("Rewrite the session layer, risk-first").length - 1;
    expect(occurrences).toBe(1);
  });

  it("labels each batch group with its own batch", () => {
    expect(graphMarkup).toContain("Migration probes");
    expect(graphMarkup).toContain("Flaky test sweep");
  });
});
