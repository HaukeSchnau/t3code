import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as DesktopOpenWorkspace from "./DesktopOpenWorkspace.ts";

describe("DesktopOpenWorkspace", () => {
  it("parses workspace open requests from supported schemes", () => {
    assert.equal(
      DesktopOpenWorkspace.parseDesktopOpenWorkspaceUrl("t3://open?cwd=/Users/dev/t3code"),
      "/Users/dev/t3code",
    );
    assert.equal(
      DesktopOpenWorkspace.parseDesktopOpenWorkspaceUrl(
        "t3code:///open?cwd=%2FUsers%2Fdev%2Fwith%20spaces",
      ),
      "/Users/dev/with spaces",
    );
    assert.equal(
      DesktopOpenWorkspace.parseDesktopOpenWorkspaceUrl("t3code-dev://open?cwd=/repo"),
      "/repo",
    );
  });

  it("ignores unsupported actions and malformed requests", () => {
    assert.isNull(DesktopOpenWorkspace.parseDesktopOpenWorkspaceUrl("t3://settings"));
    assert.isNull(DesktopOpenWorkspace.parseDesktopOpenWorkspaceUrl("t3://open"));
    assert.isNull(DesktopOpenWorkspace.parseDesktopOpenWorkspaceUrl("t3://open?cwd=%20"));
    assert.isNull(
      DesktopOpenWorkspace.parseDesktopOpenWorkspaceUrl("t3code://codex/resume?threadId=thread-1"),
    );
    assert.isNull(DesktopOpenWorkspace.parseDesktopOpenWorkspaceUrl("https://open?cwd=/repo"));
    assert.isNull(DesktopOpenWorkspace.parseDesktopOpenWorkspaceUrl("not-a-url"));
  });

  it.effect("queues workspace deeplinks in arrival order until they are taken", () =>
    Effect.gen(function* () {
      const openWorkspace = yield* DesktopOpenWorkspace.DesktopOpenWorkspace;

      assert.isTrue(openWorkspace.dispatchUrl("t3://open?cwd=/repo/one"));
      assert.isFalse(openWorkspace.dispatchUrl("t3://settings"));
      assert.isTrue(openWorkspace.dispatchUrl("t3code://open?cwd=/repo/two"));

      assert.equal(yield* openWorkspace.take, "/repo/one");
      assert.equal(yield* openWorkspace.take, "/repo/two");
    }).pipe(Effect.provide(DesktopOpenWorkspace.layer)),
  );
});
