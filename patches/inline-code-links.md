# Inline-code web links

## Purpose

Agents often wrap URLs in backticks. Markdown parsers then render the URL as code and skip normal
autolinking, which forces the user to copy and paste it into a browser.

## Requirements

- An inline-code span that consists entirely of an HTTP URL or a likely bare web domain is
  clickable while retaining its code styling.
- Bare domains open over HTTPS.
- Detection stays conservative around dotted source identifiers and filenames. For example,
  `node.meta` and `index.ts` remain code.
- Fenced code blocks are never linkified.
- Explicit Markdown links that use code as their label remain a single link.
- Web, desktop, iOS, and Android chat renderers apply the same URL detection.

## Maintenance notes

- Shared URL recognition lives in `packages/shared/src/markdownLinks.ts`.
- The web renderer transforms matching inline-code AST nodes in
  `apps/web/src/markdown-inline-code-links.ts`.
- Mobile's native selectable renderer adds link metadata to matching code runs. The Android
  fallback handles the same case in `apps/mobile/src/features/threads/ThreadFeed.tsx`.

Retire this patch if upstream linkifies code-formatted URLs on every client with equally
conservative filename detection.
