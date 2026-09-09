import { isPublishedMarkdownUrl, resolvePublishedMarkdownDestination } from "./markdownLinks.ts";
import { describe, expect, it } from "vite-plus/test";

import { resolveInlineCodeWebLink } from "./markdownLinks.js";

describe("resolveInlineCodeWebLink", () => {
  it("accepts complete HTTP and HTTPS URLs", () => {
    expect(resolveInlineCodeWebLink("https://files.schnau.dev/schnipsel-app/")).toEqual({
      href: "https://files.schnau.dev/schnipsel-app/",
      host: "files.schnau.dev",
    });
    expect(resolveInlineCodeWebLink("http://localhost:5173/chat")).toEqual({
      href: "http://localhost:5173/chat",
      host: "localhost",
    });
  });

  it("gives bare web domains an HTTPS destination", () => {
    expect(resolveInlineCodeWebLink("files.schnau.dev")).toEqual({
      href: "https://files.schnau.dev/",
      host: "files.schnau.dev",
    });
    expect(resolveInlineCodeWebLink("www.example.com/docs")).toEqual({
      href: "https://www.example.com/docs",
      host: "www.example.com",
    });
  });

  it("does not mistake filenames or code fragments for web links", () => {
    expect(resolveInlineCodeWebLink("index.ts")).toBeNull();
    expect(resolveInlineCodeWebLink("node.meta")).toBeNull();
    expect(resolveInlineCodeWebLink("https://example.com && deploy")).toBeNull();
  });

  it("rejects non-web protocols", () => {
    expect(resolveInlineCodeWebLink("javascript:alert(1)")).toBeNull();
    expect(resolveInlineCodeWebLink("file:///tmp/report.html")).toBeNull();
  });
});

describe("published Markdown destinations", () => {
  const base = "https://files.schnau.dev/reports/incident.md?revision=2#summary";
  it.each([
    ["./diagram.svg", "https://files.schnau.dev/reports/diagram.svg"],
    ["../appendix.md#evidence", "https://files.schnau.dev/appendix.md#evidence"],
    ["/assets/image.png", "https://files.schnau.dev/assets/image.png"],
    ["#timeline", "#timeline"],
    ["https://example.com/doc", "https://example.com/doc"],
    ["", ""],
  ])("resolves %s against the document", (href, expected) => {
    expect(resolvePublishedMarkdownDestination(href, base)).toBe(expected);
  });
  it.each(["report.md", "report.MD", "report.markdown", "report%2Emd"])("recognizes %s", (path) => {
    expect(isPublishedMarkdownUrl(`https://files.schnau.dev/${path}?revision=2#summary`)).toBe(
      true,
    );
  });
});
