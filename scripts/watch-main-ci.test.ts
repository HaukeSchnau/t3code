// @effect-diagnostics nodeBuiltinImport:off - tests the standalone repository CLI.
import { assert, describe, it } from "@effect/vitest";

import { newestRunForCommit, parseWorkflowRuns } from "./watch-main-ci.ts";

describe("main CI watcher", () => {
  it("selects the newest matching workflow run for the current commit", () => {
    const runs = parseWorkflowRuns({
      workflow_runs: [
        {
          id: 10,
          status: "completed",
          conclusion: "cancelled",
          head_sha: "old",
          path: "project-release.yml@refs/heads/main",
          html_url: "https://example.test/10",
        },
        {
          id: 12,
          status: "in_progress",
          conclusion: null,
          head_sha: "new",
          path: "project-release.yml@refs/heads/main",
          html_url: "https://example.test/12",
        },
        {
          id: 11,
          status: "completed",
          conclusion: "failure",
          head_sha: "new",
          path: "project-release.yml@refs/heads/main",
          html_url: "https://example.test/11",
        },
      ],
    });

    assert.strictEqual(newestRunForCommit(runs, "new", "project-release.yml")?.id, 12);
  });

  it("ignores runs from other commits and workflows", () => {
    const runs = parseWorkflowRuns({
      workflow_runs: [
        {
          id: 13,
          status: "completed",
          conclusion: "success",
          head_sha: "new",
          path: "nightly.yml@refs/heads/main",
          html_url: "https://example.test/13",
        },
      ],
    });
    assert.strictEqual(newestRunForCommit(runs, "new", "project-release.yml"), undefined);
  });

  it("rejects malformed API responses", () => {
    assert.throws(() => parseWorkflowRuns({ workflow_runs: [{ id: "wrong" }] }), /invalid/);
  });
});
