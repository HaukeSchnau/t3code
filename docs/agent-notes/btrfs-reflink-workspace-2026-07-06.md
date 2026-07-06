# BTRFS Reflink Workspace Follow-Up - 2026-07-06

## Goal

- Extend guarded directory-copy workspaces from local APFS to the Linux BTRFS
  topology used by `srv-2`.
- Keep the Linux path conservative: only use reflinks when source and workspace
  parent are both BTRFS, and force GNU `cp` to fail rather than full-copy when
  reflinks are unavailable.

## srv-2 Probe Results

- Infra config mounts `/home` as a BTRFS subvolume on `srv-2`.
- Live service topology:
  - `t3code.service` runs as `haukeschnau`.
  - `HOME=/home/haukeschnau`.
  - `T3CODE_HOME=/home/haukeschnau/.t3`.
  - Working directory is `/home/haukeschnau`.
- Live filesystem data:
  - `/home`, `/home/haukeschnau`, and `/home/haukeschnau/.t3` have stat device
    `49`.
  - Statfs magic for those paths is `0x9123683e`, the BTRFS magic value.
  - The host had roughly 538 GiB available during probing.
- Small proof copy:
  - Created a 64 MiB source directory under `~/.t3/workspace-probes`.
  - `cp -a --reflink=always src dest` succeeded.
  - The destination reported the same logical `du` size as the source while
    consuming only about 200 KiB of additional free space after the source
    existed.
- Cross-subvolume proof:
  - `/tmp` has stat device `37`; `~/.t3/workspace-probes` has stat device `49`.
  - `cp -a --reflink=always /tmp/source ~/.t3/workspace-probes/dest` still
    succeeded, proving `stat.dev` differs across subvolumes even when BTRFS can
    reflink between them.
- Large proof copy:
  - Guarded on at least 100 GiB free space before allocating.
  - Created a 6 GiB source under `~/.t3/workspace-probes`.
  - Source allocation delta was 6,445,346,816 bytes.
  - Reflink destination allocation delta was only 176,128 bytes.
  - Source and destination both reported 6,442,455,040 bytes via `du -B1 -s`.
  - Probe cleanup left `~/.t3/workspace-probes` at 0 bytes.

## Implementation Plan

- [x] Detect Linux BTRFS from statfs magic `0x9123683e`.
- [x] Treat Linux BTRFS-to-BTRFS copies as a guarded copy-on-write mode.
- [x] Use GNU `cp -a --reflink=always` for the BTRFS primary copy so unsupported
      reflinks fail instead of silently becoming full copies.
- [x] Run focused workspace tests.
- [x] Run project checks.
- [x] Run real BTRFS host filesystem smoke tests on `srv-2`.

## Open Questions

- Distinct BTRFS filesystems can share the same statfs type while not supporting
  reflinks between each other. The implementation still stays disk-safe because
  `--reflink=always` fails instead of copying data and the monitored copy path
  bounds transient metadata growth before any fallback is considered.
