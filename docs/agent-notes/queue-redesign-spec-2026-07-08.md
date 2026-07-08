# Queue Redesign Spec Notes

## Goal

Fix the queued-message strip after the upstream composer glass update and align it with the current web design language.

## Current Findings

- Queue UI lives in `apps/web/src/components/chat/QueuedMessagesStrip.tsx`.
- It is used by the main chat composer in `apps/web/src/components/ChatView.tsx` and monitor tiles in `apps/web/src/components/MonitorView.tsx`.
- The composer now has shared translucent chrome in `apps/web/src/index.css`:
  - `chat-composer-glass`
  - `chat-composer-shared-blur`
  - `chat-composer-lower-chrome`
- The current queue strip uses a floating card model:
  - `bg-card/90`
  - `-mb-5`
  - `pb-8`
  - `shadow-sm`
- This likely causes the bad visual read in the screenshot: the queue card tucks under the translucent composer, so two semi-transparent planes overlap and make the queue look washed out and spatially confused.
- The newer component language uses `bg-popover`/`bg-card` with `not-dark:bg-clip-padding`, subtle border/shadow treatment, small radii, and purposeful `before` shadows instead of broad translucent stacked panels.

## Assumptions

- The queue should remain visually connected to the composer because it represents pending composer work.
- The queue should not look like a separate modal/card hovering behind the composer.
- Main chat and monitor should share the same component API, but may need layout-specific density classes.
- The first fix should be web-only unless mobile has the same regression.

## Design Direction

Recommended: convert the queue from an overlapping floating card into a composer-attached tray.

The tray should read as the top chamber of the composer assembly:

- no negative bottom margin,
- no hidden-under-composer bottom padding,
- solid or near-solid surface rather than extra glass,
- max width aligned with the composer,
- compact rows with strong truncation and stable action sizes,
- a small queue count/header only when more than one item is queued,
- the first queued message should be immediately legible in the collapsed visual state.

## Candidate Treatments

### Option A: Attached Tray

The queue renders directly above the composer as a rounded top tray with a shared width and a small gap or joined border.

Pros:

- Fixes the transparency stacking problem directly.
- Keeps queue ownership obvious.
- Matches the new component surfaces.

Cons:

- Needs careful border/radius treatment so the composer and queue feel related without becoming one oversized card.

### Option B: Inline Queue Row Inside Composer

The queue becomes a row inside the composer, above the textarea.

Pros:

- Most clearly tied to the send action.
- Avoids separate overlay layout.

Cons:

- Raises composer height and can crowd pending approvals, attachments, and command suggestions.
- More invasive because it moves queue rendering into `ChatComposer`.

### Option C: Slim Timeline Dock

The queue is rendered as a compact dock at the bottom of the message timeline, visually above the composer but independent from it.

Pros:

- Keeps composer simpler.
- Queue reads as pending timeline work.

Cons:

- Less obvious that queued items came from composer submissions.
- Still needs careful handling around scroll-to-bottom and overlay insets.

## Recommended Spec

Use Option A.

Component behavior:

- Keep `QueuedMessagesStrip` as the shared component.
- Add a `density` or `surface` prop only if monitor needs different spacing.
- Do not introduce runtime logic changes.
- Keep current actions:
  - dispatch queued message,
  - delete queued message.
- Preserve existing ARIA list/listitem roles and per-message action labels.

Visual requirements:

- The strip must not overlap the composer with negative margins.
- The strip must not rely on backdrop blur or low-alpha glass.
- The outer surface should use the current design language: border, `bg-popover` or `bg-card`, `not-dark:bg-clip-padding`, `shadow-xs/5`, and subtle `before` shadow if needed.
- Rows should use rounded-md/rounded-lg hover states, not full card styling.
- Primary text should be `text-foreground`, not `text-foreground/75`, unless there is a separate metadata label.
- Attachments metadata should remain visible but secondary.
- Actions should use icon buttons or icon+text only where space allows; maintain touch targets via existing `Button` sizes.

Layout requirements:

- Main chat: queue aligns to composer max width (`max-w-3xl`) and horizontal inset.
- Monitor: queue fits narrow tile composer without overflowing; likely `max-w-none w-full`.
- Long message text truncates and never pushes actions off-screen.
- Multiple queued items scroll within a bounded height.
- Mobile/narrow view keeps only icons for actions.

Verification plan:

- Run `vp check` and `vp run typecheck` after implementation.
- Use browser verification for:
  - light theme,
  - dark theme,
  - one queued message,
  - multiple queued messages,
  - narrow/mobile width,
  - monitor tile queue.
- Compare against the screenshot failure mode: no double translucent overlap, no washed-out content, no composer collision.

## Open Questions

- Should queued messages be visually labeled as `Queued`/`Next`/`Waiting`, or is the spatial tray enough?
- Should `Steer` remain the action label, or should the new design make it `Send now` for clarity?
- Should the queue surface join directly to the composer border, or sit with a 4-8px gap?
- Should this redesign also touch the blue `Queue` primary button styling, or only the queued-message strip?

## Repo State Notes

- Before this planning note, remotes were fetched with `jj git fetch --remote origin` and `jj git fetch --remote upstream`.
- `jj status` reported a clean working copy but a conflicted `main` bookmark/name. Do not resolve that as part of the queue redesign unless explicitly requested.
