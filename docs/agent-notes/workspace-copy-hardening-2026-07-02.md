# Workspace Copy Hardening - 2026-07-02

## Goal

- Prevent managed Workspace creation from wedging the T3 Code server when a
  non-Git project points at a broad directory such as `/Users/haukeschnau`.
- Preserve active agents by making failures happen before provider sessions or
  long filesystem copies start.

## Root Cause

- A directory-copy workspace attempted to create a checkout under
  `/Users/haukeschnau/.t3/workspaces/haukeschnau/...` while the source was
  `/Users/haukeschnau`.
- That made the destination a descendant of the source, causing recursive copy
  behavior and repeated connection timeouts from the UI.

## Implemented Safeguards

- Directory-copy preflight refuses destination paths inside the source tree.
- Directory-copy preflight refuses sensitive roots, including the filesystem
  root, the user home, `.t3`, `.codex`, `.ssh`, and `~/Library`.
- Directory-copy preflight measures source size and free space before copying.
  `T3CODE_DIRECTORY_COPY_MAX_BYTES` overrides the default 5 GiB source limit.
- Directory-copy provisioning persists `preparing`, then `copying`, `active`, or
  `failed` lifecycle state so diagnostics can see stuck or failed workspaces.
- Long copy and `du` work runs through the async process runner with timeouts.
- macOS uses APFS clone-on-write via `cp -cR`, with `rsync -a` fallback.

## Verification

- `vp test apps/server/src/workspace/ThreadWorkspaceService.test.ts` passed.
- `vp run typecheck` passed.
- `vp check` passed with seven pre-existing mobile schema-compile warnings.
- Real browser test against `https://t3code-message-fork.localhost`:
  created a draft for project `haukeschnau`, switched it to Workspace mode, and
  sent a verification prompt. The UI failed fast with the descendant-check error,
  restored the prompt for retry, and stayed connected.
- Browser-side fetch to
  `http://127.0.0.1:13773/.well-known/t3/environment` succeeded immediately
  after the failed send.
- No lingering `cp`, `rsync`, `du`, or `.t3/workspaces/haukeschnau` process was
  present after the failed browser request.

## Follow-Ups

- Consider surfacing preflight refusal reasons as friendlier UI copy.
- Consider an admin diagnostics view for `preparing` and `copying` workspace
  rows, including elapsed time and failure details.
- If broad directory projects are still useful, explore explicit opt-in allow
  rules plus exclude lists before relaxing the sensitive-root guard.
