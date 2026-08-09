import { assert, describe, it } from "@effect/vitest";

import {
  collectReconciliationReport,
  parseDiffSummary,
  renderReconciliationReport,
  type ReadonlyCommand,
} from "./fork-reconciliation-report.ts";

describe("fork reconciliation report", () => {
  it("parses and sorts JJ summary paths without interpreting filenames", () => {
    assert.deepStrictEqual(parseDiffSummary("M z file.ts\nA apps/a/package.json\nD a.ts\n"), [
      "a.ts",
      "apps/a/package.json",
      "z file.ts",
    ]);
  });

  it("reports repeated reconciliation paths, fork touchpoints, and generated warnings", () => {
    const commands: ReadonlyCommand[] = [];
    const runCommand = (command: ReadonlyCommand): string => {
      commands.push(command);
      if (command.args[0] === "log") {
        return [
          "bbbbbbbbbbbbbbbb\tmerge: sync upstream main",
          "aaaaaaaaaaaaaaaa\tmerge: sync upstream main",
          "cccccccccccccccc\tfeat: ordinary merge",
          "",
        ].join("\n");
      }
      if (command.args.includes("aaaaaaaaaaaaaaaa")) {
        return "M pnpm-lock.yaml\nM apps/web/src/components/ChatView.tsx\n";
      }
      if (command.args.includes("bbbbbbbbbbbbbbbb")) {
        return "M apps/web/src/components/ChatView.tsx\nM apps/web/src/routeTree.gen.ts\n";
      }
      return [
        "M pnpm-lock.yaml",
        "M packages/shared/package.json",
        "M apps/web/src/components/ChatView.tsx",
        "M flake.nix",
        "",
      ].join("\n");
    };

    const report = collectReconciliationReport({
      rootDir: "/repo",
      from: "main@upstream",
      to: "main",
      runCommand,
    });

    assert.deepStrictEqual(
      report.syncMerges.map((merge) => merge.commitId),
      ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"],
    );
    assert.deepStrictEqual(report.repeatedPaths, [
      { path: "apps/web/src/components/ChatView.tsx", count: 2 },
    ]);
    assert.deepStrictEqual(report.touchpoints, [
      "apps/web/src/routeTree.gen.ts",
      "flake.nix",
      "packages/shared/package.json",
      "pnpm-lock.yaml",
    ]);
    assert.ok(report.warnings.some((warning) => warning.includes("instead of hand-merging")));
    assert.ok(report.warnings.some((warning) => warning.includes("pnpm-deploy-lock.yaml")));
    assert.ok(report.warnings.some((warning) => warning.includes("flake.nix")));
    assert.ok(report.warnings.some((warning) => warning.includes("Generated source")));
    assert.ok(
      commands.every(
        (command) => command.command === "jj" && ["log", "diff"].includes(command.args[0] ?? ""),
      ),
    );
  });

  it("renders deterministic Markdown", () => {
    const report = {
      from: "upstream",
      to: "fork",
      syncMerges: [
        {
          commitId: "1234567890abcdef",
          description: "merge: sync upstream | main",
          paths: ["a.ts"],
        },
      ],
      repeatedPaths: [{ path: "a.ts", count: 2 }],
      currentForkPaths: ["a.ts"],
      touchpoints: [],
      warnings: [],
    };

    const first = renderReconciliationReport(report);
    const second = renderReconciliationReport(report);
    assert.equal(first, second);
    assert.include(first, "| `1234567890ab` | 1 | merge: sync upstream \\| main |");
    assert.include(first, "- 2× `a.ts`");
  });
});
