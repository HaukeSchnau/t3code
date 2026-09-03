import { type ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";

export const MAX_PROVIDER_TURN_RETRY_ATTEMPTS = 5;

const BASE_RETRY_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 80_000;
const JITTER_RATIO = 0.2;

function stableUnitInterval(value: string) {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) / 0xffff_ffff;
}

export function providerTurnRetryDelayMs(threadId: ThreadId, attempt: number) {
  const exponentialDelay = Math.min(
    BASE_RETRY_DELAY_MS * 2 ** Math.max(0, attempt - 1),
    MAX_RETRY_DELAY_MS,
  );
  const jitter = 1 - JITTER_RATIO + stableUnitInterval(`${threadId}:${attempt}`) * JITTER_RATIO * 2;
  return Math.round(exponentialDelay * jitter);
}

export function providerTurnRetryAt(input: {
  readonly threadId: ThreadId;
  readonly attempt: number;
  readonly failedAt: string;
}) {
  return DateTime.makeUnsafe(input.failedAt).pipe(
    DateTime.addDuration(Duration.millis(providerTurnRetryDelayMs(input.threadId, input.attempt))),
    DateTime.formatIso,
  );
}
