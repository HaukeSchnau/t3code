import { ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";

import { providerTurnRetryAt, providerTurnRetryDelayMs } from "./providerTurnRetry.ts";

const THREAD_ID = ThreadId.make("thread-retry");

it("uses capped exponential delays with stable jitter", () => {
  const delays = [1, 2, 3, 4, 5].map((attempt) => providerTurnRetryDelayMs(THREAD_ID, attempt));

  expect(delays[0]).toBeGreaterThanOrEqual(4_000);
  expect(delays[0]).toBeLessThanOrEqual(6_000);
  expect(delays[1]).toBeGreaterThanOrEqual(8_000);
  expect(delays[1]).toBeLessThanOrEqual(12_000);
  expect(delays[4]).toBeGreaterThanOrEqual(64_000);
  expect(delays[4]).toBeLessThanOrEqual(96_000);
  expect(providerTurnRetryDelayMs(THREAD_ID, 3)).toBe(delays[2]);
});

it("derives the durable retry timestamp from the failure time", () => {
  const delay = providerTurnRetryDelayMs(THREAD_ID, 1);
  expect(
    providerTurnRetryAt({ threadId: THREAD_ID, attempt: 1, failedAt: "2026-01-01T00:00:00Z" }),
  ).toBe(
    `2026-01-01T00:00:${String(Math.floor(delay / 1_000)).padStart(2, "0")}.${String(delay % 1_000).padStart(3, "0")}Z`,
  );
});
