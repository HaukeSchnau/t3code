import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as DesktopOpenWorkspace from "./DesktopOpenWorkspace.ts";

function makeHarness() {
  const sends: { readonly channel: string; readonly args: readonly unknown[] }[] = [];
  const reveals: unknown[] = [];
  const mainWindow = { id: "main-window" };

  const window = ElectronWindow.ElectronWindow.of({
    create: () => Effect.die("not used"),
    main: Effect.succeed(Option.some(mainWindow as never)),
    currentMainOrFirst: Effect.succeed(Option.some(mainWindow as never)),
    focusedMainOrFirst: Effect.succeed(Option.some(mainWindow as never)),
    setMain: () => Effect.void,
    clearMain: () => Effect.void,
    reveal: (target) =>
      Effect.sync(() => {
        reveals.push(target);
      }),
    sendAll: (channel, ...args) =>
      Effect.sync(() => {
        sends.push({ channel, args });
      }),
    destroyAll: Effect.void,
    syncAllAppearance: () => Effect.void,
  });

  return {
    sends,
    reveals,
    layer: Layer.mergeAll(
      DesktopOpenWorkspace.layer,
      Layer.succeed(ElectronWindow.ElectronWindow, window),
    ),
  };
}

describe("DesktopOpenWorkspace", () => {
  it("parses workspace open requests from supported schemes", () => {
    assert.deepEqual(
      DesktopOpenWorkspace.parseDesktopOpenWorkspaceUrl("t3://open?cwd=/Users/dev/t3code"),
      { cwd: "/Users/dev/t3code" },
    );
    assert.deepEqual(
      DesktopOpenWorkspace.parseDesktopOpenWorkspaceUrl(
        "t3code:///open?cwd=%2FUsers%2Fdev%2Fwith%20spaces",
      ),
      { cwd: "/Users/dev/with spaces" },
    );
    assert.deepEqual(
      DesktopOpenWorkspace.parseDesktopOpenWorkspaceUrl("t3code-dev://open?cwd=/repo"),
      { cwd: "/repo" },
    );
  });

  it("ignores unsupported actions and malformed requests", () => {
    assert.isNull(DesktopOpenWorkspace.parseDesktopOpenWorkspaceUrl("t3://settings"));
    assert.isNull(DesktopOpenWorkspace.parseDesktopOpenWorkspaceUrl("t3://open"));
    assert.isNull(DesktopOpenWorkspace.parseDesktopOpenWorkspaceUrl("https://open?cwd=/repo"));
    assert.isNull(DesktopOpenWorkspace.parseDesktopOpenWorkspaceUrl("not-a-url"));
  });

  it.effect("queues requests until the web bridge consumes pending requests", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const openWorkspace = yield* DesktopOpenWorkspace.DesktopOpenWorkspace;
      yield* openWorkspace.dispatchUrl("t3://open?cwd=/repo/one");

      assert.deepEqual(harness.sends, []);
      assert.deepEqual(yield* openWorkspace.consumePending, [{ cwd: "/repo/one" }]);

      yield* openWorkspace.dispatchUrl("t3://open?cwd=/repo/two");

      assert.deepEqual(harness.sends, [
        {
          channel: IpcChannels.OPEN_WORKSPACE_REQUEST_CHANNEL,
          args: [{ cwd: "/repo/two" }],
        },
      ]);
      assert.lengthOf(harness.reveals, 1);
    }).pipe(Effect.provide(harness.layer));
  });
});
