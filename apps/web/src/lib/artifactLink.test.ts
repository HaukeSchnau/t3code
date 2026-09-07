import { describe, expect, it } from "vite-plus/test";

import { artifactReloadUrl, parseArtifactLink, shouldOpenArtifactInPanel } from "./artifactLink";

describe("published artifact links", () => {
  it("reloads with a fresh URL while keeping document parameters and fragments", () => {
    const href = "https://files.schnau.dev/report.html?view=wide#results";
    expect(artifactReloadUrl(href, 123)).toBe(
      "https://files.schnau.dev/report.html?view=wide&_t3_reload=123#results",
    );
    expect(artifactReloadUrl(artifactReloadUrl(href, 123), 456)).toBe(
      "https://files.schnau.dev/report.html?view=wide&_t3_reload=456#results",
    );
  });
  it.each([
    "report.html",
    "report.PDF",
    "notes.md",
    "data.json",
    "notes.txt",
    "prototype/",
    "report",
  ])("recognizes %s without losing query parameters or fragments", (path) => {
    const url = `https://files.schnau.dev/${path}?revision=2#details`;
    expect(parseArtifactLink(url)?.url).toBe(url);
  });

  it("normalizes URLs and decodes filenames for tab titles", () => {
    expect(parseArtifactLink("https://FILES.SCHNAU.DEV:443/reports/My%20report.html")).toEqual({
      url: "https://files.schnau.dev/reports/My%20report.html",
      title: "My report.html",
    });
  });

  it.each([
    "https://files.schnau.dev/",
    "http://files.schnau.dev/report.html",
    "https://files.schnau.dev:8443/report.html",
    "https://files.schnau.dev.example.com/report.html",
    "https://other.files.schnau.dev/report.html",
    "https://user:pass@files.schnau.dev/report.html",
    "https://files.schnau.dev/%zz.html",
    "javascript:alert(1)",
    "/report.html",
    "https://files.schnau.dev/photo.png",
    "https://files.schnau.dev/logo.svg",
    "https://files.schnau.dev/movie.mp4",
    "https://files.schnau.dev/archive.zip",
    "https://files.schnau.dev/data.csv",
  ])("leaves %s to its existing link action", (href) => {
    expect(parseArtifactLink(href)).toBeNull();
  });

  const click = {
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
  };
  it("opens ordinary and keyboard-activated clicks in the panel", () => {
    expect(shouldOpenArtifactInPanel(click)).toBe(true);
  });
  it.each(["defaultPrevented", "metaKey", "ctrlKey", "shiftKey", "altKey"])(
    "preserves %s gestures",
    (property) => expect(shouldOpenArtifactInPanel({ ...click, [property]: true })).toBe(false),
  );
  it("preserves middle clicks", () => {
    expect(shouldOpenArtifactInPanel({ ...click, button: 1 })).toBe(false);
  });
});
