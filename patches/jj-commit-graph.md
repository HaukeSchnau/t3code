# JJ Commit Graph Workstation

## Goal

Add a JJ-only commit graph as a first-class right-panel workspace while keeping the existing
`git.*` API namespace. The graph should make local JJ history inspectable and actionable without
renaming the Git-shaped contracts that the rest of T3 Code already uses.

## Product Decisions

- The graph lives in the existing right-panel system next to the Diff panel.
- `panel=graph` opens the graph. Existing `diff=1` behavior remains intact, and `panel=graph`
  wins when both values are present.
- The branch toolbar shows an "Open JJ graph" icon only when status reports `vcs: "jj"`.
- The graph uses React Flow for pan/zoom, minimap, node selection, and canvas ergonomics.
- Rows/details remain dense and work-focused: the canvas shows graph structure, while the inspector
  holds metadata and actions.

## API Additions

The API intentionally keeps `git.*` names:

- `git.commitGraph`
- `git.commitGraphChangeDetails`
- `git.runCommitGraphAction`

New contract shapes:

- `GitCommitGraphInput`
- `GitCommitGraphResult`
- `GitCommitGraphNode`
- `GitCommitGraphEdge`
- `GitCommitGraphChangeDetailsInput`
- `GitCommitGraphChangeDetailsResult`
- `GitCommitGraphActionInput`
- `GitCommitGraphActionResult`

Git repositories return `supported: false`; colocated JJ repositories return structured graph data.

## Right-Panel Behavior

- Desktop/wide layout uses the existing resizable right sidebar.
- Narrow layout uses the existing right-panel sheet.
- The graph panel fetches a bounded recent revset by default:
  `ancestors(visible_heads() | bookmarks() | tracked_remote_bookmarks() | @, <limit>)`
- Default limit is `150`; max contract limit is `500`.

## React Flow Dependency Rationale

React Flow is intentionally added because this feature is a canvas-map workflow, not a static list.
It gives T3 Code reliable pan/zoom, minimap, selection, and edge rendering without building custom
hit-testing and viewport controls.

## JJ Command Mapping

- Operation guard: `jj op log --limit 1 -T 'id.short() ++ "\n"'`
- Graph nodes:
  `jj log --no-graph --color never --limit <limit+1> -r <revset> -T <ndjson-template>`
- Details:
  - `jj root` to resolve repo-root-relative paths for file tree and rendered diffs
  - `jj diff --summary -r <change>`
  - `jj show --git --context 3 -r <change>`
- Actions:
  - edit: `jj edit <change>`
  - describe: `jj describe -r <change> -m <message>`
  - new: `jj new <parents...> [-m <message>] [--no-edit]`
  - insert: `jj new -A <change>` or `jj new -B <change>`
  - abandon: `jj abandon <changes...>`
  - duplicate: `jj duplicate <changes...>`
  - rebase: `jj rebase -s|-b|-r <revset> -o|-A|-B <destinations...>`
  - squash: `jj squash --from <change> --into <change>`
  - split: `jj split -r <change> <filesets...>`
  - bookmark set: `jj bookmark set <name> -r <change>`
  - bookmark move: `jj bookmark move <name> --to <change>`
  - bookmark rename/delete/track/untrack map directly to `jj bookmark`.

## Safety and Confirmation Rules

- Every mutating graph action includes `expectedOperationId`.
- The server rejects the action if the repository operation changed after the graph loaded.
- Risky operations require `confirmed: true` in the action payload.
- The UI confirmation dialog previews the exact JJ command and mentions operation-log recovery.

## Non-Goals

- Git commit graph parity.
- Interactive patch editing for `jj split`.
- Operation-log undo UI.
- Changes to GitHub PR creation/resolution.
- Replacing existing checkpoint or workspace-indexing Git plumbing.

## Testing / Verification Checklist

- Server graph tests should cover JJ graph loading, limit truncation, stale operation rejection,
  describe, and bookmark actions.
- Routing tests should prove Git repos return an unsupported graph result.
- Web tests should cover graph route parsing and panel state.
- Required verification remains:
  - `bun fmt`
  - `bun lint`
  - `bun typecheck`
  - affected `bun run test` commands, never `bun test`
