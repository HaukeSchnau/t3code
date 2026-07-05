# APFS CoW Workspace Follow-Up - 2026-07-05

## Goal

- Let directory-copy workspaces handle large APFS directories on this machine
  without requiring full logical source size as free disk space.
- Keep the implementation bounded so failed or unexpectedly expanding copies do
  not fill the disk.

## Local Experiment Results

- `~/Code/typeflake` logical size: 411 MiB; APFS clone completed in 2s and used
  about 6 MiB of additional free space while present.
- `~/Code/Studienbuch` logical size: about 18.1 GiB; APFS clone completed in
  32s and peaked around 234 MiB of additional free space.
- Full `~/Code` logical size: about 33.8 GiB; APFS clone completed in 122s and
  peaked around 136 MiB of additional free space.
- Broad copies can contain read-only package-cache files. Cleanup needed
  `chmod -R u+w` semantics inside the throwaway copy before `rm -rf`.

## Implementation Plan

- [x] Detect APFS same-device copy-on-write eligibility for directory-copy
      workspaces.
- [x] For eligible CoW copies, skip the source-size limit and use a live free-space
      guard while copying.
- [x] Harden workspace delete/failed-copy cleanup by making copied paths user
      writable before removal, while avoiding chmod of symlink targets.

## Verification Status

- `vp test apps/server/src/workspace/ThreadWorkspaceService.test.ts` passed.
- `vp run typecheck` passed with pre-existing desktop Effect suggestions.
- `vp check` passed with seven pre-existing mobile schema-compile warnings.
- Real service-layer `~/Code` directory-copy smoke passed with
  `T3CODE_DIRECTORY_COPY_MAX_BYTES=1`.
  - Source logical size: 34,582,024,192 bytes.
  - Policy: `copy-on-write-guarded`.
  - Destination filesystem type: `apfs`.
  - Peak transient usage reported by service: 254,976,000 bytes.
  - Prepare elapsed: 118,468 ms.
  - Delete elapsed total: 158,618 ms.
  - Checkout and isolated test base directory were removed.
