// Full-detail streams must stop as soon as their last visible owner unmounts.
// The persisted snapshot makes revisits cheap without reducing and serializing
// every provider delta for an inactive thread.
export const THREAD_STATE_IDLE_TTL_MS = 0;

// Thread detail snapshots keep their replay cursor alive while a route is
// mounted. The V2 state uses the same zero-TTL policy as the shell state.
export const THREAD_SNAPSHOT_IDLE_TTL_MS = THREAD_STATE_IDLE_TTL_MS;
