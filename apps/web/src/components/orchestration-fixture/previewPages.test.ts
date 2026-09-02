import { describe, expect, it } from "vitest";

import { isPreviewNavMessage, normalizePreviewPath, renderDocsPage } from "./previewPages";

describe("fixture preview pages", () => {
  it("normalizes typed paths onto known pages", () => {
    expect(normalizePreviewPath("")).toBe("/docs/");
    expect(normalizePreviewPath("docs/remote")).toBe("/docs/remote");
    expect(normalizePreviewPath("/docs/remote/")).toBe("/docs/remote");
    expect(normalizePreviewPath("/docs/missing")).toBe("/docs/missing");
  });

  it("renders the same page content for both variants and marks the current nav item", () => {
    const nav = renderDocsPage("nav", "/docs/remote");
    const style = renderDocsPage("style", "/docs/remote");
    expect(nav).toContain("<h1>Connect remotely</h1>");
    expect(style).toContain("<h1>Connect remotely</h1>");
    expect(nav).toContain('href="/docs/remote" aria-current="page"');
    expect(nav).not.toBe(style);
    expect(renderDocsPage("nav", "/docs/nope")).toContain("<h1>Not found</h1>");
  });

  it("recognizes only navigation messages posted by the page script", () => {
    expect(isPreviewNavMessage({ type: "t3-fixture-preview-nav", path: "/docs/" })).toBe(true);
    expect(isPreviewNavMessage({ type: "t3-fixture-preview-nav" })).toBe(false);
    expect(isPreviewNavMessage("nope")).toBe(false);
  });
});
