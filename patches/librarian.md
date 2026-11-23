# Librarian

## Fork requirement

Agents in a fleet world need to read code in repositories their thread has not checked out. The
Librarian gives them three MCP tools that answer from a zoekt index of every repository in a world,
so a question about another repository costs one tool call instead of a clone or a guess
([#191](https://git.schnau.dev/schnau/t3code/issues/191), step 4b). Upstream has no cross-repository
search.

## Behavior

- **Infra owns the index.** `~/infra` runs one `zoekt-webserver -rpc` per world and sets
  `T3CODE_LIBRARIAN_WORLDS` on each host to a JSON array of `{world, url}`. T3 only calls zoekt's
  `/api/search` and `/api/list`. Without the variable, or with an invalid one (logged as a warning),
  the server does not register the tools, so agents elsewhere never see them.
- **Repository names are forge paths** without scheme, such as `git.schnau.dev/schnau/t3code`, set
  by infra with `zoekt.name`. Output paths are `<repo>/<path>`; `librarian_read_file` takes that
  string back and finds the repository by the longest indexed name that prefixes it.
- **`librarian_search` matches `git grep -F`** in literal mode. zoekt reads every term as a regex,
  splits on spaces, and treats `"` as query syntax, so literal mode escapes the pattern and writes
  spaces and quotes as `\x20` and `\x22`; each line of a pattern is its own pattern, as in git.
  Regexes and the `repo` and `path` filters go through zoekt's quoted argument, which hands RE2 the
  pattern unchanged.
  The query always sets `case:yes` unless `ignoreCase`, because zoekt otherwise ignores case for
  all-lowercase patterns. Files zoekt skipped (binary, over 2 MB, too many trigrams) never match.
- **Output is rg's.** zoekt returns line matches by score and repeats shared context, so the tool
  sorts lines by number, merges context, caps lines at 500 characters around the first match, and
  separates groups with `--`. It raises zoekt's match limits to 100,000 and reports `truncated`
  when zoekt counted more matching lines than it returned or skipped files. Vendored `.repos/`,
  `node_modules` and lockfiles (`*-lock.*`, `*.lock`) are excluded unless `includeVendored`.
  zoekt stores a `NOT-INDEXED: <reason>` placeholder as the content of each file it skipped, so
  every search excludes those exact bodies.
- **Reads fall back to the forge.** `librarian_read_file` reads the file through zoekt's `Whole`
  option. For files zoekt marked `NOT-INDEXED` other than binaries, it reads the indexed commit from
  the forge with the CLI the host is already signed in to: `gh` for github.com, `tea` when a tea
  login matches the host, `glab` otherwise.
- **One world down is not an error** when searching all worlds: the result lists
  `unreachableWorlds`.

## Upstream touch points

- `apps/server/src/librarian/` is fork-only.
- `apps/server/src/mcp/toolkits/librarian/` and one conditional registration in
  `McpHttpServer.layerTools`; `server.ts` provides `Librarian.layer`.
- `AgentContextBudget.test.ts` measures the tools as a configured host sees them, so
  `agentContextBudget.json` includes them.
- `evals/mcp-tool-use` lists the toolkit and has `cases/librarian.ndjson`.

## Removal

Remove this when upstream ships cross-repository search that agents can call without a checkout,
or when the world view (#191 step 4c) makes every repository readable as a normal path and agents
no longer need separate tools.
