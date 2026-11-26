import { worldRepositoryNamespace } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/** Where infra keeps every world's repositories (patches/worldfs.md). */
export const WORLDS_CACHE = "/var/lib/worlds";

/** A world's `catalog.json`: every repository in the world and its local mirror. */
export const decodeWorldCatalog = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      repos: Schema.Array(Schema.Struct({ name: Schema.String, mirror: Schema.String })),
    }),
  ),
);

/** The repository namespaces each world's catalog holds. A world without a catalog is left out. */
export const readWorldNamespaces = Effect.fn("WorldCatalog.readNamespaces")(function* (
  worlds: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const namespaces: Record<string, ReadonlyArray<string>> = {};
  for (const world of worlds) {
    const catalog = Option.getOrUndefined(
      decodeWorldCatalog(
        yield* fs
          .readFileString(path.join(WORLDS_CACHE, world, "catalog.json"))
          .pipe(Effect.orElseSucceed(() => "")),
      ),
    );
    if (catalog === undefined) continue;
    namespaces[world] = [
      ...new Set(catalog.repos.map((repo) => worldRepositoryNamespace(repo.name))),
    ].sort();
  }
  return namespaces;
});
