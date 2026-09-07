# Full historical detail on demand

## Requirement

Keep normal thread transport bounded while preserving access to complete historical tool output,
file changes, dynamic-tool values, and subagent detail. Truncating a transport preview must never
make the persisted detail inaccessible. Inactive threads must not retain full-detail subscriptions.

## Native V2 implementation

Upstream V2 owns turn-item projection, pagination, and native item rendering. The former V1
activity-descriptor and per-turn hydration implementation is superseded on this path.

`WireProjection.ts` limits large detail fields on normal snapshots and live events. The
`getTurnItems` RPC reads complete native items from the projection, scoped to the owning thread.
Clients request exact item IDs when opening a preview, which also covers imported items with no
provider turn ID. Provider-turn selection remains available for callers that need a whole turn.
Both selections are bounded by the request contract and use indexed lookups.

Web and desktop load full details from the work-item disclosure and subagent card. Mobile loads
from the work-log detail disclosure. Loading is explicit, with retry on failure. Hydrated values
are scoped to the environment, thread, item, and item version; a newer preview invalidates an old
value without continuously refetching streaming output. No background transcript subscription is
created for hydration.

## Verification

Server tests cover full 100 KB output, indexed provider-turn selection, exact item selection,
items without provider turns, exclusion of another thread's item, and empty selections. Shared
client tests identify transport previews for command output, file changes, dynamic tools, and
subagent details. The server and client contracts retain native item types through decoding.

Keep this patch until upstream provides equivalent bounded transport and complete on-demand
item access on web, desktop, and mobile.
