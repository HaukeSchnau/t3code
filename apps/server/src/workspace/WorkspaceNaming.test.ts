// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  fallbackWorkspaceSeed,
  withWorkspaceReservation,
  workspaceName,
} from "./WorkspaceNaming.ts";

const tempDir = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-workspace-naming-"));

it("names a workspace from its semantic seed within 32 characters", () => {
  assert.equal(
    workspaceName({ seed: "Generate fitting workspace URLs", fallbackSeed: "studienbuch" }),
    "generate-fitting-workspace-urls",
  );
  assert.equal(
    workspaceName({
      seed: "Übermäßig große Änderung für langlebige, projektübergreifende Entwicklungsumgebungen",
      fallbackSeed: "studienbuch",
    }),
    "ubermassig-grosse-anderung-fur",
  );
});

it("falls back to an opaque name when no seed is available", () => {
  const fallback = fallbackWorkspaceSeed(
    ThreadId.make("thread:7f3a9c21-55d0-4b1e-9e1f-0a6d1c2b3e4f"),
  );
  assert.equal(workspaceName({ seed: "  ", fallbackSeed: fallback }), "task-1c2b3e4f");
});

it.effect("adds a suffix only for live collisions", () =>
  Effect.gen(function* () {
    const parentPath = tempDir();
    const input = { parentPath, seed: "Improve workspace URL naming", fallbackSeed: "x" };
    const nested = yield* withWorkspaceReservation(input, (first) =>
      withWorkspaceReservation(input, (second) => Effect.succeed([first.name, second.name])),
    );
    assert.deepEqual(nested, ["improve-workspace-url-naming", "improve-workspace-url-naming-2"]);
    // Released reservations free the name again.
    const again = yield* withWorkspaceReservation(input, (reservation) =>
      Effect.succeed(reservation.name),
    );
    assert.equal(again, "improve-workspace-url-naming");
  }),
);

it.effect("never reuses a path threads still reference or a name the VCS already uses", () =>
  Effect.gen(function* () {
    const parentPath = tempDir();
    const referenced = yield* withWorkspaceReservation(
      {
        parentPath,
        seed: "Fix login",
        fallbackSeed: "x",
        unavailablePaths: new Set([NodePath.join(parentPath, "fix-login")]),
      },
      (reservation) => Effect.succeed(reservation.name),
    );
    assert.equal(referenced, "fix-login-2");
    const jjName = yield* withWorkspaceReservation(
      {
        parentPath,
        seed: "Fix login",
        fallbackSeed: "x",
        unavailableNames: new Set(["fix-login"]),
      },
      (reservation) => Effect.succeed(reservation.name),
    );
    assert.equal(jjName, "fix-login-2");
  }),
);
