import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createOfflineAuthRevalidationController } from "./offlineAuthRevalidation";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("offline authentication revalidation", () => {
  it("invalidates and clears proof exactly at expiry even while revalidation is pending", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const invalidate = vi.fn(async () => undefined);
    const clearProof = vi.fn();
    const controller = createOfflineAuthRevalidationController({
      revalidate: () => new Promise(() => undefined),
      invalidate,
      clearProof,
      proofExpiresAtEpochMs: () => 12_000,
    });

    controller.start();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(invalidate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(clearProof).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledOnce();
    controller.stop();
  });

  it("chunks a 30-day proof without overflowing the platform timer delay", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-07-15T00:00:00.000Z").getTime();
    vi.setSystemTime(startedAt);
    const invalidate = vi.fn(async () => undefined);
    const clearProof = vi.fn();
    const controller = createOfflineAuthRevalidationController({
      revalidate: () => new Promise(() => undefined),
      invalidate,
      clearProof,
      proofExpiresAtEpochMs: () => startedAt + 30 * 24 * 60 * 60 * 1_000,
    });

    controller.start();
    await vi.advanceTimersByTimeAsync(29 * 24 * 60 * 60 * 1_000);
    expect(clearProof).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);
    expect(clearProof).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledOnce();
    controller.stop();
  });

  it("retries route invalidation rejection at the expiry boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const clearProof = vi.fn();
    const invalidate = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("router unavailable"))
      .mockResolvedValue(undefined);
    const controller = createOfflineAuthRevalidationController({
      revalidate: () => new Promise(() => undefined),
      invalidate,
      clearProof,
      proofExpiresAtEpochMs: () => 11_000,
    });

    controller.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(clearProof).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(250);
    expect(invalidate).toHaveBeenCalledTimes(2);
    controller.stop();
  });

  it.each(["authenticated", "requires-auth"])(
    "invalidates routes after authoritative %s revalidation",
    async (status) => {
      const invalidate = vi.fn(async () => undefined);
      const controller = createOfflineAuthRevalidationController({
        revalidate: async () => ({ status }),
        invalidate,
        clearProof: vi.fn(),
        proofExpiresAtEpochMs: () => Date.now() + 60_000,
      });

      controller.start();
      await vi.waitFor(() => expect(invalidate).toHaveBeenCalledOnce());
      controller.stop();
    },
  );

  it("uses online and visible-application wakeups to interrupt retry backoff", async () => {
    vi.useFakeTimers();
    const revalidate = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValue({ status: "authenticated" });
    const invalidate = vi.fn(async () => undefined);
    const controller = createOfflineAuthRevalidationController({
      revalidate,
      invalidate,
      clearProof: vi.fn(),
      proofExpiresAtEpochMs: () => Date.now() + 60_000,
    });

    controller.start();
    await vi.waitFor(() => expect(revalidate).toHaveBeenCalledTimes(1));
    controller.wake();
    await vi.waitFor(() => expect(revalidate).toHaveBeenCalledTimes(2));
    expect(invalidate).toHaveBeenCalledOnce();
    controller.stop();
  });
});
