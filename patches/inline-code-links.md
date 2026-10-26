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
- The web renderer transforms matching inline-code AST nodes in
  `apps/web/src/markdown-inline-code-links.ts`. Upstream moved the remark plugin lists to
  `packages/shared/src/markdownPipeline.ts`, which the server's in-thread find also uses, so
  `ChatMarkdown` appends `remarkLinkifyInlineCode` after the shared list instead of editing it. Running
  after `remarkNormalizeLinksAndTagInlineCode` is equivalent: the plugin rebuilds the code node inside
  the new link without the inline-code tag, and linking changes no text.
- Mobile renders Markdown with `react-native-enriched-markdown`. Upstream rewrites file-path code
  spans into Markdown links before rendering (`markdownForNativeRendering`), which gives them link
  pills and the iOS link menu but drops code styling. The fork only widens that rewrite's pattern to
  `ENRICHED_INLINE_CODE_LINK_REGEX` (upstream's file-path pattern plus `INLINE_CODE_WEB_LINK_PATTERN`,
  in `apps/mobile/src/lib/enrichedLinkPresentation.ts`). The span becomes the link URL, so
  `enrichedLinkUrl` gives a bare host its `https://` scheme in `EnrichedMarkdownText.tsx`'s press and
  menu handlers and in `useEnrichedLinkVariants`.

Retire this patch if upstream linkifies code-formatted URLs on every client with equally
conservative filename detection.
