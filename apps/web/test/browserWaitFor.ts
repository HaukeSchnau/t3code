import { vi } from "vite-plus/test";

// The fork's CI runs browser tests on aarch64 hosts, where heavy file previews outlast
// `vi.waitFor`'s one-second default. Vitest has no setting for it (patches/nixos-ci-portability.md).
const waitFor = vi.waitFor;
vi.waitFor = ((callback, options) =>
  waitFor(
    callback,
    typeof options === "number" ? options : { timeout: 5_000, ...options },
  )) as typeof vi.waitFor;
