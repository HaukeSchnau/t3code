import { vi } from "vite-plus/test";

// Vitest's one-second `vi.waitFor` default fails heavy file previews on loaded Calder workers long
// before the 30 s browser test timeout. Every wait, including upstream's per-call 10 s ones, gets at
// least just under it, which keeps the assertion message. Vitest has no setting for the default
// (patches/nixos-ci-portability.md).
const minimumTimeout = 25_000;
const waitFor = vi.waitFor;
vi.waitFor = ((callback, options) => {
  const given = typeof options === "number" ? { timeout: options } : (options ?? {});
  return waitFor(callback, { ...given, timeout: Math.max(given.timeout ?? 0, minimumTimeout) });
}) as typeof vi.waitFor;
