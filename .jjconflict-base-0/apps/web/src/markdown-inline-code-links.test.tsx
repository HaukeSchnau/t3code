import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vite-plus/test";

import { remarkLinkifyInlineCode } from "./markdown-inline-code-links";

function renderMarkdown(markdown: string): string {
  return renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkLinkifyInlineCode]}>{markdown}</ReactMarkdown>,
  );
}

describe("remarkLinkifyInlineCode", () => {
  it("makes a code-formatted URL clickable and keeps its code styling", () => {
    expect(renderMarkdown("Open `https://files.schnau.dev/schnipsel-app/`.")).toBe(
      '<p>Open <a href="https://files.schnau.dev/schnipsel-app/"><code>https://files.schnau.dev/schnipsel-app/</code></a>.</p>',
    );
  });

  it("links a bare domain wrapped in code", () => {
    expect(renderMarkdown("Open `files.schnau.dev`.")).toBe(
      '<p>Open <a href="https://files.schnau.dev/"><code>files.schnau.dev</code></a>.</p>',
    );
  });

  it("leaves ordinary inline and fenced code alone", () => {
    expect(renderMarkdown("Use `index.ts`.\n\n```text\nhttps://example.com\n```")).toBe(
      '<p>Use <code>index.ts</code>.</p>\n<pre><code class="language-text">https://example.com\n</code></pre>',
    );
  });

  it("does not create a nested link inside an explicit Markdown link", () => {
    expect(renderMarkdown("[`example.com`](https://example.com)")).toBe(
      '<p><a href="https://example.com"><code>example.com</code></a></p>',
    );
  });
});
