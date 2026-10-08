import { describe, expect, it } from "vite-plus/test";

import {
  distributeMarkdownHighlight,
  highlightMarkdownRuns,
  markdownRunsSearchText,
  type MarkdownTextHighlight,
} from "@t3tools/mobile-markdown-text/highlight";
import { nativeMarkdownDocumentRuns } from "@t3tools/mobile-markdown-text/markdown";

const findAll = (needle: string) => (text: string) =>
  [...text.matchAll(new RegExp(needle, "g"))].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));

const highlight = (current: number): MarkdownTextHighlight => ({
  find: findAll("probe"),
  current,
  color: "yellow",
  currentColor: "orange",
});

describe("highlightMarkdownRuns", () => {
  it("splits a match that crosses styled runs and marks only the current one as current", () => {
    const runs = [{ text: "the pro" }, { text: "be and a probe", bold: true }];
    const text = markdownRunsSearchText(runs);
    expect(
      highlightMarkdownRuns(runs, findAll("probe")(text), 1).map((run) => [
        run.text,
        run.bold ?? false,
        run.highlight ?? null,
      ]),
    ).toEqual([
      ["the ", false, null],
      ["pro", false, "match"],
      ["be", true, "match"],
      [" and a ", true, null],
      ["probe", true, "current"],
    ]);
  });

  it("leaves chips whole and never matches list markers", () => {
    const runs = [
      { text: "•\t", role: "list-marker" as const },
      { text: "probe.ts", href: "file:///probe.ts", fileIcon: "text" as const },
      { text: " ok" },
    ];
    const text = markdownRunsSearchText(runs);
    expect(text.startsWith("\n\n")).toBe(true);
    expect(highlightMarkdownRuns(runs, findAll("probe")(text), 0)).toEqual(runs);
  });

  it("reads rendered markdown, not its syntax", () => {
    const runs = nativeMarkdownDocumentRuns({
      type: "document",
      children: [
        {
          type: "list",
          children: [{ type: "list_item", children: [{ type: "text", content: "probe" }] }],
        },
      ],
    });
    expect(findAll("probe")(markdownRunsSearchText(runs))).toHaveLength(1);
    expect(markdownRunsSearchText(runs)).not.toContain("•");
  });
});

describe("distributeMarkdownHighlight", () => {
  const counts = [2, 0, 3];

  it("counts the current range from each part's own start", () => {
    expect(
      distributeMarkdownHighlight(highlight(3), counts, (count) => count).map(
        (part) => part?.current,
      ),
    ).toEqual([-1, -1, 1]);
  });

  it("marks the last range when the reader's count runs past what renders", () => {
    expect(
      distributeMarkdownHighlight(highlight(9), counts, (count) => count, {
        clampToLast: true,
      }).map((part) => part?.current),
    ).toEqual([-1, -1, 2]);
  });

  it("skips counting when nothing is current", () => {
    const quiet = highlight(-1);
    expect(
      distributeMarkdownHighlight(quiet, counts, () => {
        throw new Error("counted");
      }),
    ).toEqual([quiet, quiet, quiet]);
  });
});
