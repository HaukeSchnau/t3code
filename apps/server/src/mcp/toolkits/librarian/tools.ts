import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as Librarian from "../../../librarian/Librarian.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [McpInvocationContext.McpInvocationContext, Librarian.Librarian],
};

const World = Schema.optional(
  Schema.String.annotate({ description: "One world from librarian_list_repos. Default: all." }),
);

const LibrarianSearchTool = Tool.make("librarian_search", {
  ...shared,
  description:
    "Search every repository in a world without checking anything out, like rg across all of them at once. The index holds each repository's default branch as pushed, so it misses uncommitted and unpushed work; search your own checkout with grep or rg. " +
    "`pattern` is a literal string, or RE2 (rg syntax) with `regex`. Case-sensitive unless `ignoreCase`. `repo` and `path` are regexes on the repository name and the file path. Vendored `.repos/`, `node_modules` and lockfiles are skipped unless `includeVendored`; binary files and files over 2 MB never match. " +
    "`output` is rg's `<repo>/<path>:<line>:<text>`, with `-` on context lines and `--` between groups; read a hit with librarian_read_file. `truncated` means more matches exist: narrow `repo` or `path`, or raise `limit`.",
  parameters: Schema.Struct({
    pattern: Schema.NonEmptyString,
    regex: Schema.optional(Schema.Boolean),
    ignoreCase: Schema.optional(Schema.Boolean),
    world: World,
    repo: Schema.optional(Schema.String),
    path: Schema.optional(Schema.String),
    context: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10 })).annotate({
        description: "Lines before and after each match, like rg -C.",
      }),
    ),
    limit: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2000 })).annotate({
        description: "Matching lines. Default 200.",
      }),
    ),
    includeVendored: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Struct({
    output: Schema.String,
    files: Schema.Number,
    matchedLines: Schema.Number,
    truncated: Schema.Boolean,
    unreachableWorlds: Schema.optional(Schema.Array(Schema.String)),
  }),
})
  .annotate(Tool.Title, "Search all repositories")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const LibrarianReadFileTool = Tool.make("librarian_read_file", {
  ...shared,
  description:
    "Read a file from any repository in a world without checking it out, at the commit the index holds. `file` is `<repo>/<path>` as librarian_search prints it. Returns up to `limit` lines (default 2000) from line `offset` (default 1); `totalLines` tells you whether there is more.",
  parameters: Schema.Struct({
    file: Schema.NonEmptyString,
    world: World,
    offset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10000 }))),
  }),
  success: Schema.Struct({
    file: Schema.String,
    world: Schema.String,
    commit: Schema.optional(Schema.String),
    source: Schema.Literals(["index", "forge"]),
    startLine: Schema.Number,
    endLine: Schema.Number,
    totalLines: Schema.Number,
    content: Schema.String,
  }),
})
  .annotate(Tool.Title, "Read a file from any repository")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const LibrarianListReposTool = Tool.make("librarian_list_repos", {
  ...shared,
  description:
    "List the repositories each world indexes, by name: the forge path without scheme, such as `github.com/owner/name`. `prefix` keeps names that start with it.",
  parameters: Schema.Struct({ world: World, prefix: Schema.optional(Schema.String) }),
  success: Schema.Struct({
    worlds: Schema.Array(
      Schema.Struct({ world: Schema.String, repos: Schema.Array(Schema.String) }),
    ),
  }),
})
  .annotate(Tool.Title, "List indexed repositories")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const LibrarianToolkit = Toolkit.make(
  LibrarianSearchTool,
  LibrarianReadFileTool,
  LibrarianListReposTool,
);
