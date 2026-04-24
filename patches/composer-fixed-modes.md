# Composer Fixed Modes

## Goal

Simplify this fork's composer footer by removing mode controls that are never used locally.

## Requirements

- Remove the composer access selector from desktop and compact footer layouts.
- Do not show `Full access`, `Auto-accept edits`, or `Supervised` as composer controls.
- Always dispatch composer turns with runtime mode `full-access`.
- Remove composer `Fast Mode` controls and the `Fast` / `Normal` footer indicator.
- Always use the normal/default speed by omitting `fastMode` from composer model selections.
- Keep stored legacy draft/thread/model state intact; stale `runtimeMode` or `fastMode` values may remain persisted but must not affect composer sends.
- Keep the Plan/Build interaction mode toggle unchanged.
- Keep the patch narrowly scoped to the web composer path.

## Non-Goals

- No provider protocol, contract, or WebSocket schema changes.
- No server provider implementation changes.
- No persistence migrations or stored-settings cleanup.
- No global settings redesign.
- No removal of Plan mode.

## Rationale

This is a fork-specific ergonomics patch. Keeping it local to the composer UI and dispatch path makes the change easy to review, easy to rebase, and low risk for upstream churn.
