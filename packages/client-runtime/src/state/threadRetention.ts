// Full-detail streams must stop as soon as their last visible owner unmounts.
// The persisted snapshot makes revisits cheap without reducing and serializing
// every provider delta for an inactive thread.
export const THREAD_STATE_IDLE_TTL_MS = 0;
