# Inline-code web links

## Purpose

Agents often wrap URLs in backticks. Markdown parsers then render the URL as code and skip normal
autolinking, which forces the user to copy and paste it into a browser.

## Requirements

- An inline-code span that consists entirely of an HTTP URL or a likely bare web domain is
  clickable. Web and desktop keep its code styling; mobile renders it like upstream's file-path
  links in code spans.
- Bare domains open over HTTPS.
- Detection stays conservative around dotted source identifiers and filenames. For example,
  `node.meta` and `index.ts` remain code.
- Fenced code blocks are never linkified.
- Explicit Markdown links that use code as their label remain a single link.
- Web, desktop, iOS, and Android chat renderers apply the same URL detection.

## Maintenance notes

- Shared URL recognition lives in `packages/shared/src/markdownLinks.ts`.
- Web and desktop render Markdown with Words (`apps/web/src/markdown/wordsHast.ts`), which has no
  remark plugins. Its `transform` wraps an inline `code` element outside a link in an `<a>` when
  `resolveInlineCodeWebLink` matches its text, and leaves the `code` inside without the inline-code
  tag, as Words does for code in an explicit link. A `<code>` with markup inside is skipped: Words
  already links a raw HTML `<code>`'s address inside it. `wordsHast.test.ts` covers the cases.
- Mobile renders Markdown with `react-native-enriched-markdown`. Upstream rewrites file-path code
  spans into Markdown links before rendering (`markdownForNativeRendering`), which gives them link
  pills and the iOS link menu but drops code styling. The fork only widens that rewrite's pattern to
  `ENRICHED_INLINE_CODE_LINK_REGEX` (upstream's file-path pattern plus `INLINE_CODE_WEB_LINK_PATTERN`,
  in `apps/mobile/src/lib/enrichedLinkPresentation.ts`). The span becomes the link URL, so
  `enrichedLinkUrl` gives a bare host its `https://` scheme in `EnrichedMarkdownText.tsx`'s press and
  menu handlers and in `useEnrichedLinkVariants`.

Retire this patch if upstream linkifies code-formatted URLs on every client with equally
conservative filename detection. On web, the hook is the one branch in `wordsHast.ts`'s
`transform`.
