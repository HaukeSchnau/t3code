import { vi } from "vite-plus/test";

// Vitest's one-second `vi.waitFor` default fails heavy file previews on loaded Calder workers long
// before the 30 s browser test timeout. Waiting until just under it keeps the assertion message.
// Vitest has no setting for the default (patches/nixos-ci-portability.md).
const waitFor = vi.waitFor;
vi.waitFor = ((callback, options) =>
  waitFor(
    callback,
    typeof options === "number" ? options : { timeout: 25_000, ...options },
  )) as typeof vi.waitFor;
