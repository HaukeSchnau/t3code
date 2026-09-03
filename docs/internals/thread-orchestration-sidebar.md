# Thread orchestration sidebar projection

The orchestration sidebar is a client-side projection of durable coordination facts. The server shell
publishes `createdBy`, `forkedFrom`, replacement, effort, and wait records; clients combine those
records with the environment-scoped thread shells they already render. No sidebar-only relationship
state or sample hierarchy crosses the wire.

`packages/client-runtime/src/state/threadCoordination.ts` owns the shared projection. It first gives
explicit effort membership display ownership, then derives one canonical row per visible thread.
Replacement chains keep only the latest attempt in the main tree and expose earlier attempts behind a
separate container. Stable container IDs cover lineages, efforts, unassigned children, retry history,
and past efforts. The projection returns a flat item stream so each client can use its normal virtual
list and production thread card.

Expansion is intentionally client-local UI state. Web and desktop start lineage, effort, and
unassigned containers open while keeping retry and past-effort history closed. Mobile starts all
orchestration containers closed. A selected descendant records every container on its placement path;
when any one is closed, the projection adds a **Viewing** item whose reveal action opens that exact
path.

Lifecycle remains the outermost placement rule. Snoozed and settled threads stay on their existing
flat shelves, and search results stay flat. The orchestration projection receives the live inbox rows,
so collapsing a root hides its complete visible recursive subtree without duplicating parked work.
Pin state is a display boundary inside that inbox: an edge whose endpoints have different pin states
is split into two roots, while same-pin descendants retain their hierarchy. This keeps every pinned
thread above the divider without hoisting unpinned descendants into the pinned block.
Closed efforts with visible work remain in the current tree; closed efforts with no live members are
represented by compact history rows. Active or attention-needed effort sections sort before completed
and closed sections without time-based reordering.

Web owns the DOM row controls and pinned drag-and-drop. Desktop wraps the web client and therefore
uses the same projection and interactions without Electron-specific code. Mobile consumes the same
projection in both the phone Home list and tablet navigation sidebar, with native disclosure and
reveal controls. The model is provider-neutral and environment-scoped, so local, remote, relay, and
tunnel connections follow the same behavior.
