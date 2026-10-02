// @effect-diagnostics nodeBuiltinImport:off - tests the standalone repository CLI.
import { assert, describe, it } from "@effect/vitest";

import { newestStatus, parseOptions, parseStatuses } from "./watch-main-ci.ts";

describe("main CI watcher", () => {
  it("selects the newest status of the Kiln context", () => {
    const statuses = parseStatuses([
      { id: 10, status: "failure", context: "kiln", target_url: "https://kiln.test/run/1" },
      { id: 12, status: "pending", context: "kiln", target_url: "https://kiln.test/run/2" },
      { id: 11, status: "success", context: "kiln/static", target_url: "https://kiln.test/run/2" },
    ]);

    assert.strictEqual(newestStatus(statuses, "kiln")?.id, 12);
  });

  it("ignores other contexts", () => {
    const statuses = parseStatuses([
      { id: 13, status: "success", context: "kiln/static", target_url: "https://kiln.test/run/3" },
    ]);
    assert.strictEqual(newestStatus(statuses, "kiln"), undefined);
  });

  it("rejects malformed API responses", () => {
    assert.throws(() => parseStatuses([{ id: "wrong" }]), /invalid/);
  });

  it("accepts the argument separator forwarded by the workspace runner", () => {
    const options = parseOptions(["--", "--revision", "abc123", "--poll-seconds", "15"]);

    assert.strictEqual(options.revision, "abc123");
    assert.strictEqual(options.pollMilliseconds, 15_000);
    assert.strictEqual(options.context, "kiln");
  });
});
