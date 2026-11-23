import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ForgeRawFile from "./ForgeRawFile.ts";
import * as Librarian from "./Librarian.ts";

const REPO = "git.example.com/acme/app";
const COMMIT = "0123456789abcdef";

/** A zoekt webserver holding one repository whose files map to their indexed content. */
const zoekt = (files: Record<string, string>) =>
  HttpClient.make((request) =>
    Effect.sync(() => {
      const body = JSON.parse(
        new TextDecoder().decode(
          request.body._tag === "Uint8Array" ? request.body.body : undefined,
        ),
      ) as { Q: string };
      const json = (value: unknown) => HttpClientResponse.fromWeb(request, Response.json(value));
      if (request.url.startsWith("http://down"))
        return HttpClientResponse.fromWeb(request, new Response("", { status: 503 }));
      if (request.url.endsWith("/api/list"))
        return json({ List: { Repos: [{ Repository: { Name: REPO } }] } });
      // The `file:` argument as zoekt unquotes it, an RE2 anchored on the path.
      const fileRegex = /file:"((?:[^"\\]|\\.)*)"/.exec(body.Q)?.[1]?.replace(/\\(.)/g, "$1");
      const path = Object.keys(files).find((name) => new RegExp(fileRegex ?? "$^").test(name));
      return json({
        Result: {
          FileCount: path ? 1 : 0,
          MatchCount: path ? 1 : 0,
          FilesSkipped: 0,
          ShardsSkipped: 0,
          Files: path
            ? [
                {
                  FileName: path,
                  Repository: REPO,
                  Version: COMMIT,
                  Content: Buffer.from(files[path]!).toString("base64"),
                },
              ]
            : null,
        },
      });
    }),
  );

const run = <A, E>(
  files: Record<string, string>,
  use: (librarian: Librarian.Librarian["Service"]) => Effect.Effect<A, E>,
  worlds = [{ world: "acme", url: "http://index:6070/" }],
) => {
  const forgeReads: Array<{ repo: string; ref: string; path: string }> = [];
  const layer = Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, zoekt(files)),
    Layer.succeed(
      ForgeRawFile.ForgeRawFile,
      ForgeRawFile.ForgeRawFile.of({
        read: (input) => {
          forgeReads.push(input);
          return Effect.succeed("from the forge\nline 2\n");
        },
      }),
    ),
  );
  return Librarian.make(worlds).pipe(
    Effect.flatMap(use),
    Effect.provide(layer),
    Effect.map((value) => ({ value, forgeReads })),
  );
};

describe("Librarian.readFile", () => {
  it.effect(
    "reads indexed files from zoekt and the rest from the forge at the indexed commit",
    () =>
      Effect.gen(function* () {
        const files = {
          "src/small.ts": "one\ntwo\nthree\n",
          "vendor/huge.c": "NOT-INDEXED: exceeds the maximum size limit",
          "logo.png": "NOT-INDEXED: contains binary content",
          "notes.md": "NOT-INDEXED: contains binary content, says this note\n",
        };

        const indexed = yield* run(files, (librarian) =>
          librarian.readFile({ file: `${REPO}/src/small.ts`, offset: 2, limit: 1 }),
        );
        expect(indexed.value).toMatchObject({
          source: "index",
          world: "acme",
          commit: COMMIT,
          content: "two",
          startLine: 2,
          endLine: 2,
          totalLines: 3,
        });
        expect(indexed.forgeReads).toEqual([]);

        const skipped = yield* run(files, (librarian) =>
          librarian.readFile({ file: `${REPO}/vendor/huge.c` }),
        );
        expect(skipped.value).toMatchObject({ source: "forge", content: "from the forge\nline 2" });
        expect(skipped.forgeReads).toEqual([{ repo: REPO, ref: COMMIT, path: "vendor/huge.c" }]);

        const binary = yield* run(files, (librarian) =>
          librarian.readFile({ file: `${REPO}/logo.png` }).pipe(Effect.flip),
        );
        expect(binary.value).toMatchObject({
          _tag: "LibrarianFileNotFoundError",
          reason: "binary",
        });
        expect(binary.forgeReads).toEqual([]);

        // Only zoekt's exact placeholder marks a skipped file.
        const note = yield* run(files, (librarian) =>
          librarian.readFile({ file: `${REPO}/notes.md` }),
        );
        expect(note.value).toMatchObject({ source: "index", totalLines: 1 });

        // A world that does not answer must not hide a file another world holds.
        const oneWorldDown = yield* run(
          files,
          (librarian) => librarian.readFile({ file: `${REPO}/src/small.ts` }),
          [
            { world: "down", url: "http://down:6070" },
            { world: "acme", url: "http://index:6070" },
          ],
        );
        expect(oneWorldDown.value).toMatchObject({ world: "acme", content: "one\ntwo\nthree" });

        const unknownRepo = yield* run(files, (librarian) =>
          librarian.readFile({ file: "git.example.com/acme/other/x.ts" }).pipe(Effect.flip),
        );
        expect(unknownRepo.value).toMatchObject({ reason: "no-repo" });
      }),
  );
});
