# Mobile Native Content Surfaces

## Goal

Keep the mobile conversation experience responsive and recognizably native while preserving the
same source content and remote-environment behavior as web and desktop.

## Requirements

- Render assistant markdown through the selectable native iOS text surface, including links,
  inline code, lists, and file references.
- Use the native composer for multiline input, slash commands, path completion, and token chips.
  Chips remain atomic editable tokens and must not expose image-preview or Save to Camera Roll
  actions merely because UIKit implements them with `NSTextAttachment`.
- Render cached review diffs through the native diff surface with horizontal and vertical scrolling,
  syntax highlighting, and word-level change highlights.
- Use Ghostty for interactive terminal sessions, including keyboard input, command transport,
  output, and reconnection.
- Keep files read-only on mobile for now; native surfaces may inspect and reference files but do not
  add a mobile file-editing path.

## Upstream Touch Points

- `apps/mobile/modules/t3-composer-editor/`
- `apps/mobile/modules/t3-markdown-text/`
- `apps/mobile/modules/t3-review-diff/`
- `apps/mobile/modules/t3-terminal/`
- `apps/mobile/src/features/threads/`

## Verification

- Run the focused composer-revision, markdown, review-diff, and terminal tests plus the mobile
  typecheck and native static checks.
- Compile the native modules through the generated iOS workspace.
- On a physical iPhone, verify text selection/copy, multiline composition and token deletion,
  large two-axis diff navigation, and a real terminal command/output round trip.
