export interface OfflineAuthRevalidationController {
  readonly start: () => void;
  readonly wake: () => void;
  readonly stop: () => void;
}

const MAX_EXPIRY_TIMER_DELAY_MS = 24 * 60 * 60 * 1_000;

export function createOfflineAuthRevalidationController(input: {
  readonly revalidate: () => Promise<unknown>;
  readonly invalidate: () => Promise<unknown>;
  readonly clearProof: () => void;
  readonly proofExpiresAtEpochMs: () => number | null;
  readonly now?: () => number;
}): OfflineAuthRevalidationController {
  const now = input.now ?? Date.now;
  let stopped = false;
  let expired = false;
  let inFlight = false;
  let retryDelayMs = 1_000;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let invalidateRetryDelayMs = 250;
  let invalidateRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let invalidating = false;

  const invalidateRoutes = async () => {
    if (stopped || invalidating) return;
    invalidating = true;
    try {
      await input.invalidate();
      invalidateRetryDelayMs = 250;
    } catch {
      if (!stopped) {
        invalidateRetryTimer = setTimeout(() => void invalidateRoutes(), invalidateRetryDelayMs);
        invalidateRetryDelayMs = Math.min(invalidateRetryDelayMs * 2, 5_000);
      }
    } finally {
      invalidating = false;
    }
  };

  const invalidateAtExpiry = () => {
    if (stopped || expired) return;
    expired = true;
    input.clearProof();
    void invalidateRoutes();
  };

  const scheduleExpiry = () => {
    const expiresAt = input.proofExpiresAtEpochMs();
    if (expiresAt === null) {
      invalidateAtExpiry();
      return;
    }
    const remainingMs = expiresAt - now();
    if (remainingMs <= 0) {
      invalidateAtExpiry();
      return;
    }
    expiryTimer = setTimeout(
      remainingMs > MAX_EXPIRY_TIMER_DELAY_MS ? scheduleExpiry : invalidateAtExpiry,
      Math.min(remainingMs, MAX_EXPIRY_TIMER_DELAY_MS),
    );
  };

  const attempt = async () => {
    if (stopped || expired || inFlight) return;
    inFlight = true;
    try {
      await input.revalidate();
      if (!stopped && !expired) await invalidateRoutes();
    } catch {
      if (stopped || expired) return;
      const expiresAt = input.proofExpiresAtEpochMs();
      if (expiresAt === null || expiresAt <= now()) {
        invalidateAtExpiry();
        return;
      }
      retryTimer = setTimeout(() => void attempt(), retryDelayMs);
      retryDelayMs = Math.min(retryDelayMs * 2, 10_000);
    } finally {
      inFlight = false;
    }
  };

  return {
    start() {
      scheduleExpiry();
      void attempt();
    },
    wake() {
      if (stopped || expired) return;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      retryDelayMs = 1_000;
      void attempt();
    },
    stop() {
      stopped = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      if (expiryTimer !== undefined) clearTimeout(expiryTimer);
      if (invalidateRetryTimer !== undefined) clearTimeout(invalidateRetryTimer);
    },
  };
}
