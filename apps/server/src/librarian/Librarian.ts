import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as ForgeRawFile from "./ForgeRawFile.ts";
import {
  decodeContent,
  formatSearch,
  skippedReason,
  searchQuery,
  wholeFileQuery,
  ZoektErrorReply,
  ZoektListReply,
  ZoektSearchReply,
  type SearchQueryInput,
  type ZoektSearchResult,
} from "./zoektQuery.ts";

export const LibrarianWorld = Schema.Struct({ world: Schema.String, url: Schema.String });
export type LibrarianWorld = typeof LibrarianWorld.Type;

/** Infra runs one `zoekt-webserver -rpc` per world and lists them here. */
const librarianWorldsConfig = Config.schema(
  Schema.fromJsonString(Schema.Array(LibrarianWorld)),
  "T3CODE_LIBRARIAN_WORLDS",
).pipe(Config.withDefault([]));

export class LibrarianWorldNotFoundError extends Schema.TaggedError<LibrarianWorldNotFoundError>()(
  "LibrarianWorldNotFoundError",
  { world: Schema.String, known: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return this.known.length === 0
      ? "No Librarian worlds are configured on this server."
      : `There is no world named ${this.world}. Worlds: ${this.known.join(", ")}.`;
  }
}

export class LibrarianUnavailableError extends Schema.TaggedError<LibrarianUnavailableError>()(
  "LibrarianUnavailableError",
  { world: Schema.String, httpStatus: Schema.optional(Schema.Number), cause: Schema.Defect() },
) {
  override get message(): string {
    return `The ${this.world} index did not answer${this.httpStatus ? ` (HTTP ${this.httpStatus})` : ""}.`;
  }
}

export class LibrarianQueryError extends Schema.TaggedError<LibrarianQueryError>()(
  "LibrarianQueryError",
  { world: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `The ${this.world} index rejected the query: ${this.reason}`;
  }
}

export class LibrarianFileNotFoundError extends Schema.TaggedError<LibrarianFileNotFoundError>()(
  "LibrarianFileNotFoundError",
  { file: Schema.String, reason: Schema.Literals(["no-repo", "no-file", "binary"]) },
) {
  override get message(): string {
    switch (this.reason) {
      case "no-repo":
        return `No indexed repository contains ${this.file}. Paths start with the repository name that librarian_list_repos shows.`;
      case "no-file":
        return `${this.file} is not in the index.`;
      case "binary":
        return `${this.file} is a binary file.`;
    }
  }
}

export type LibrarianError =
  | LibrarianWorldNotFoundError
  | LibrarianUnavailableError
  | LibrarianQueryError
  | LibrarianFileNotFoundError
  | ForgeRawFile.ForgeRawFileError;

export interface LibrarianSearchInput extends SearchQueryInput {
  readonly world?: string | undefined;
  readonly context?: number | undefined;
  readonly limit?: number | undefined;
}

export interface LibrarianSearchResult {
  readonly output: string;
  readonly files: number;
  readonly matchedLines: number;
  readonly truncated: boolean;
  readonly unreachableWorlds?: ReadonlyArray<string>;
}

export interface LibrarianReadFileResult {
  readonly file: string;
  readonly world: string;
  readonly commit: string | undefined;
  readonly source: "index" | "forge";
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
  readonly content: string;
}

export class Librarian extends Context.Service<
  Librarian,
  {
    readonly worlds: ReadonlyArray<LibrarianWorld>;
    readonly search: (
      input: LibrarianSearchInput,
    ) => Effect.Effect<LibrarianSearchResult, LibrarianError>;
    readonly readFile: (input: {
      readonly file: string;
      readonly world?: string | undefined;
      readonly offset?: number | undefined;
      readonly limit?: number | undefined;
    }) => Effect.Effect<LibrarianReadFileResult, LibrarianError>;
    readonly listRepos: (input: {
      readonly world?: string | undefined;
      readonly prefix?: string | undefined;
    }) => Effect.Effect<
      {
        readonly worlds: ReadonlyArray<{
          readonly world: string;
          readonly repos: ReadonlyArray<string>;
        }>;
        readonly unreachableWorlds?: ReadonlyArray<string>;
      },
      LibrarianError
    >;
  }
>()("t3/librarian/Librarian") {}

const DEFAULT_LIMIT = 200;
const DEFAULT_READ_LINES = 2000;
const READ_LINE_CAP = 2000;
/** zoekt stops counting at these; past them a result reports truncation instead of a total. */
const MATCH_COUNT_LIMIT = 100_000;

export const make = Effect.fn("Librarian.make")(function* (worlds: ReadonlyArray<LibrarianWorld>) {
  const http = yield* HttpClient.HttpClient;
  const forge = yield* ForgeRawFile.ForgeRawFile;

  const select = (world: string | undefined) => {
    const found = world === undefined ? worlds : worlds.filter((entry) => entry.world === world);
    return found.length > 0
      ? Effect.succeed(found)
      : Effect.fail(
          new LibrarianWorldNotFoundError({
            world: world ?? "",
            known: worlds.map((entry) => entry.world),
          }),
        );
  };

  const post = Effect.fn("Librarian.post")(
    function* <A>(
      world: LibrarianWorld,
      endpoint: "search" | "list",
      body: unknown,
      schema: Schema.Decoder<A>,
    ) {
      const unavailable = (cause: unknown, httpStatus?: number) =>
        new LibrarianUnavailableError({
          world: world.world,
          cause,
          ...(httpStatus ? { httpStatus } : {}),
        });
      const response = yield* http
        .execute(
          HttpClientRequest.post(`${world.url.replace(/\/+$/, "")}/api/${endpoint}`).pipe(
            HttpClientRequest.bodyJsonUnsafe(body),
          ),
        )
        .pipe(Effect.mapError((cause) => unavailable(cause)));
      if (response.status === 400) {
        const reply = yield* HttpClientResponse.schemaBodyJson(ZoektErrorReply)(response).pipe(
          Effect.mapError((cause) => unavailable(cause, 400)),
        );
        return yield* new LibrarianQueryError({
          world: world.world,
          reason: reply.Error.slice(0, 300),
        });
      }
      if (response.status !== 200) return yield* unavailable(undefined, response.status);
      return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
        Effect.mapError((cause) => unavailable(cause, response.status)),
      );
    },
    (effect, world) =>
      // Covers the body too: a world that stalls after its headers must not hold the call.
      Effect.timeoutOrElse(effect, {
        duration: "30 seconds",
        orElse: () =>
          Effect.fail(new LibrarianUnavailableError({ world: world.world, cause: "timeout" })),
      }),
  );

  const zoektSearch = (world: LibrarianWorld, q: string, opts: Record<string, unknown>) =>
    post(world, "search", { Q: q, Opts: opts }, ZoektSearchReply).pipe(
      Effect.map((reply) => reply.Result),
    );

  const listNames = (world: LibrarianWorld) =>
    post(world, "list", { Q: "" }, ZoektListReply).pipe(
      Effect.map((reply) => (reply.List.Repos ?? []).map((repo) => repo.Repository.Name)),
    );

  const search: Librarian["Service"]["search"] = Effect.fn("Librarian.search")(function* (input) {
    const targets = yield* select(input.world);
    const limit = input.limit ?? DEFAULT_LIMIT;
    const context = input.context ?? 0;
    const q = searchQuery(input);
    const opts = {
      ShardMaxMatchCount: MATCH_COUNT_LIMIT,
      TotalMaxMatchCount: MATCH_COUNT_LIMIT,
      NumContextLines: context,
      MaxMatchDisplayCount: limit,
    };
    const settled = yield* Effect.forEach(
      targets,
      (world) => zoektSearch(world, q, opts).pipe(Effect.result),
      { concurrency: "unbounded" },
    );
    const results: Array<ZoektSearchResult> = [];
    const unreachable: Array<LibrarianUnavailableError> = [];
    for (const outcome of settled) {
      if (outcome._tag === "Success") results.push(outcome.success);
      // A rejected query is the caller's to fix; one world being down is not.
      else if (outcome.failure._tag === "LibrarianUnavailableError")
        unreachable.push(outcome.failure);
      else return yield* outcome.failure;
    }
    if (results.length === 0) return yield* unreachable[0]!;
    const unreachableWorlds = unreachable.map((error) => error.world);
    const formatted = formatSearch(results, { context, limit });
    return unreachableWorlds.length > 0 ? { ...formatted, unreachableWorlds } : formatted;
  });

  const resolveFile = Effect.fn("Librarian.resolveFile")(function* (
    file: string,
    world: string | undefined,
  ) {
    const targets = yield* select(world);
    const lists = yield* Effect.forEach(
      targets,
      (target) => listNames(target).pipe(Effect.result),
      { concurrency: "unbounded" },
    );
    let best: { target: LibrarianWorld; repo: string } | undefined;
    let unreachable: LibrarianError | undefined;
    for (const [index, outcome] of lists.entries()) {
      if (outcome._tag === "Failure") {
        unreachable ??= outcome.failure;
        continue;
      }
      for (const repo of outcome.success) {
        if (file.startsWith(`${repo}/`) && (best === undefined || repo.length > best.repo.length))
          best = { target: targets[index]!, repo };
      }
    }
    // A world that did not answer may hold the file; say so rather than "not found".
    if (best === undefined)
      return yield* unreachable ?? new LibrarianFileNotFoundError({ file, reason: "no-repo" });
    return { ...best, path: file.slice(best.repo.length + 1) };
  });

  const readFile: Librarian["Service"]["readFile"] = Effect.fn("Librarian.readFile")(
    function* (input) {
      const { target, repo, path } = yield* resolveFile(input.file, input.world);
      const result = yield* zoektSearch(target, wholeFileQuery(repo, path), { Whole: true });
      const match = (result.Files ?? []).find(
        (file) => file.Repository === repo && file.FileName === path,
      );
      if (match === undefined)
        return yield* new LibrarianFileNotFoundError({ file: input.file, reason: "no-file" });
      const indexed = decodeContent(match.Content);
      const skipped = skippedReason(indexed);
      if (skipped?.includes("binary"))
        return yield* new LibrarianFileNotFoundError({ file: input.file, reason: "binary" });
      const text =
        skipped === undefined
          ? indexed.toString("utf8")
          : yield* forge.read({ repo, ref: match.Version ?? "HEAD", path });
      const lines = text.split("\n");
      if (lines.at(-1) === "") lines.pop();
      const start = Math.max(1, input.offset ?? 1);
      const window = lines.slice(start - 1, start - 1 + (input.limit ?? DEFAULT_READ_LINES));
      return {
        file: input.file,
        world: target.world,
        commit: match.Version,
        source: skipped === undefined ? "index" : "forge",
        startLine: start,
        endLine: start + window.length - 1,
        totalLines: lines.length,
        content: window
          .map((line) =>
            line.length > READ_LINE_CAP
              ? `${line.slice(0, READ_LINE_CAP)}… [${line.length} chars]`
              : line,
          )
          .join("\n"),
      } as const;
    },
  );

  const listRepos: Librarian["Service"]["listRepos"] = Effect.fn("Librarian.listRepos")(
    function* (input) {
      const targets = yield* select(input.world);
      const settled = yield* Effect.forEach(
        targets,
        (target) => listNames(target).pipe(Effect.result),
        { concurrency: "unbounded" },
      );
      const worlds: Array<{ world: string; repos: ReadonlyArray<string> }> = [];
      const unreachable: Array<LibrarianError> = [];
      for (const [index, outcome] of settled.entries()) {
        if (outcome._tag === "Failure") {
          unreachable.push(outcome.failure);
          continue;
        }
        worlds.push({
          world: targets[index]!.world,
          repos: outcome.success
            .filter((name) => input.prefix === undefined || name.startsWith(input.prefix))
            .toSorted(),
        });
      }
      if (worlds.length === 0) return yield* unreachable[0]!;
      const unreachableWorlds = targets
        .filter((target) => !worlds.some((entry) => entry.world === target.world))
        .map((target) => target.world);
      return unreachableWorlds.length > 0 ? { worlds, unreachableWorlds } : { worlds };
    },
  );

  return Librarian.of({ worlds, search, readFile, listRepos });
});

export const layer = Layer.effect(
  Librarian,
  Effect.gen(function* () {
    const worlds = yield* librarianWorldsConfig.pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("T3CODE_LIBRARIAN_WORLDS is invalid; the Librarian stays off.", {
          cause,
        }),
      ),
      Effect.orElseSucceed(() => []),
    );
    return yield* make(worlds);
  }),
).pipe(Layer.provide(ForgeRawFile.layer));
