import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { readWorldNamespaces } from "./worldCatalog.ts";

const catalog = (...names: ReadonlyArray<string>) =>
  JSON.stringify({ repos: names.map((name) => ({ name, mirror: `/mirrors/${name}.git` })) });

it.effect("reads each world's repository namespaces from its catalog", () => {
  const files: Record<string, string> = {
    "/var/lib/worlds/schnau/catalog.json": catalog(
      "git.schnau.dev/schnau/t3code",
      "git.schnau.dev/schnau/calder",
      "github.com/HaukeSchnau/hopwatch",
    ),
  };
  return Effect.gen(function* () {
    // A world this machine has no catalog for yet is left out.
    assert.deepEqual(yield* readWorldNamespaces(["schnau", "buildlinx"]), {
      schnau: ["git.schnau.dev/schnau", "github.com/haukeschnau"],
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        FileSystem.layerNoop({ readFileString: (path) => Effect.succeed(files[path] ?? "") }),
        Path.layer,
      ),
    ),
  );
});
