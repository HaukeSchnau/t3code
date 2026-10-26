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
  `apps/web/src/markdown-inline-code-links.ts`. Upstream moved the remark plugin lists to
  `packages/shared/src/markdownPipeline.ts`, which the server's in-thread find also uses, so
  `ChatMarkdown` appends `remarkLinkifyInlineCode` after the shared list instead of editing it. Running
  after `remarkNormalizeLinksAndTagInlineCode` is equivalent: the plugin rebuilds the code node inside
  the new link without the inline-code tag, and linking changes no text.
- Mobile renders Markdown with `react-native-enriched-markdown` on both platforms. Upstream turns
  file-path code spans into Markdown links before rendering, which drops their code styling. The
  fork passes `ENRICHED_INLINE_CODE_LINK_REGEX` (upstream's file-path pattern plus
  `INLINE_CODE_WEB_LINK_PATTERN`, in `apps/mobile/src/lib/enrichedLinkPresentation.ts`) as the
  native `linkRecognition.inlineCode` regex, so web URLs stay code-styled. The matched span becomes
  the link URL, so `enrichedLinkUrl` gives a bare host its `https://` scheme before
  `EnrichedMarkdownText.tsx` hands it to press handlers, link menus and pill presentation. Natively
  recognized links never reach `onLinksChange`, so they get no link variant or iOS link menu.

Retire this patch if upstream linkifies code-formatted URLs on every client with equally
conservative filename detection.
