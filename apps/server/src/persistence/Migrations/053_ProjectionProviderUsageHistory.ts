import * as Effect from "effect/Effect";

/**
 * Formerly backfilled usage history into the fork's provider usage-limit
 * projection. Migration 76 drops that projection, so this is a no-op that
 * stays registered to keep migration ids stable.
 */
export default Effect.void;
