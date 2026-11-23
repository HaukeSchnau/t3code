import { describe, expect, it } from "@effect/vitest";

import { capLine, formatSearch, searchQuery, type ZoektSearchResult } from "./zoektQuery.ts";

const b64 = (text: string) => Buffer.from(text).toString("base64");

const line = (
  lineNumber: number,
  text: string,
  options: { before?: string; after?: string; offset?: number; length?: number } = {},
) => ({
  Line: b64(`${text}\n`),
  LineNumber: lineNumber,
  Before: options.before === undefined ? null : b64(options.before),
  After: options.after === undefined ? null : b64(options.after),
  FileName: false,
  LineFragments: [{ LineOffset: options.offset ?? 0, MatchLength: options.length ?? 1 }],
});

const result = (
  files: ZoektSearchResult["Files"],
  stats: Partial<Omit<ZoektSearchResult, "Files">> = {},
): ZoektSearchResult => {
  const lines = (files ?? []).reduce((sum, file) => sum + (file.LineMatches?.length ?? 0), 0);
  return {
    FileCount: files?.length ?? 0,
    MatchCount: lines,
    FilesSkipped: 0,
    ShardsSkipped: 0,
    Files: files,
    ...stats,
  };
};

describe("searchQuery", () => {
  it("writes a literal so zoekt matches it like git grep -F", () => {
    expect(searchQuery({ pattern: 'run("a b")' })).toContain(
      String.raw`content:run\(\x22a\x20b\x22\)`,
    );
    expect(searchQuery({ pattern: String.raw`a.b*c\d[e]{2}|^$` })).toContain(
      String.raw`content:a\.b\*c\\d\[e\]\{2\}\|\^\$`,
    );
    // git grep -F reads each line of the pattern as its own pattern.
    expect(searchQuery({ pattern: "apple\npear|\n" })).toContain(String.raw`content:apple|pear\|`);
  });

  it("hands zoekt's RE2 the regex unchanged", () => {
    // zoekt's parseStringLiteral (query/parse.go): `\X` stands for X, `"` ends the argument.
    const unquote = (token: string) => {
      expect(token.startsWith('"') && token.endsWith('"')).toBe(true);
      return token.slice(1, -1).replace(/\\(.)/gs, "$1");
    };
    for (const regex of [
      "(foo bar)|baz",
      String.raw`say \"hi\" \ now`,
      String.raw`[)( "][^]x]`,
      String.raw`\Qa b\E`,
      "-leading or",
    ]) {
      const query = searchQuery({ pattern: regex, regex: true, includeVendored: true });
      expect(unquote(query.slice(query.lastIndexOf(" content:") + " content:".length))).toBe(regex);
    }
  });

  it("adds filters, case and exclusions as asked", () => {
    const skipped = String.raw`(case:yes -content:"\\A(NOT-INDEXED: exceeds the maximum size limit|NOT-INDEXED: contains too few trigrams|NOT-INDEXED: contains binary content|NOT-INDEXED: contains too many trigrams|NOT-INDEXED: object missing from repository)\\z")`;
    expect(
      searchQuery({
        pattern: "x",
        ignoreCase: true,
        repo: "schnau/t3code$",
        path: String.raw`\.ts$`,
        includeVendored: true,
      }),
    ).toBe(String.raw`case:no repo:"schnau/t3code$" file:"\\.ts$" ${skipped} content:x`);
    expect(searchQuery({ pattern: "x" })).toBe(
      String.raw`case:yes ${skipped} -file:^\.repos/ -file:(^|/)node_modules/ -file:(-lock\.[^/]*|\.lock)$ content:x`,
    );
  });
});

describe("formatSearch", () => {
  it("sorts score-ordered lines by line number and merges shared context", () => {
    const output = formatSearch(
      [
        result([
          {
            FileName: "src/a.ts",
            Repository: "git.example.com/acme/app",
            Content: null,
            LineMatches: [
              line(12, "twelve", { before: "ten\neleven\n", after: "thirteen\nfourteen\n" }),
              line(10, "ten", { before: "eight\nnine\n", after: "eleven\ntwelve\n" }),
              line(30, "thirty", { before: "28\n29\n", after: "31\n" }),
            ],
          },
          {
            FileName: "b.md",
            Repository: "git.example.com/acme/docs",
            Content: null,
            LineMatches: [line(1, "one", { after: "two\n" })],
          },
        ]),
      ],
      { context: 2, limit: 100 },
    );
    expect(output.output.split("\n")).toEqual([
      "git.example.com/acme/app/src/a.ts-8-eight",
      "git.example.com/acme/app/src/a.ts-9-nine",
      "git.example.com/acme/app/src/a.ts:10:ten",
      "git.example.com/acme/app/src/a.ts-11-eleven",
      "git.example.com/acme/app/src/a.ts:12:twelve",
      "git.example.com/acme/app/src/a.ts-13-thirteen",
      "git.example.com/acme/app/src/a.ts-14-fourteen",
      "--",
      "git.example.com/acme/app/src/a.ts-28-28",
      "git.example.com/acme/app/src/a.ts-29-29",
      "git.example.com/acme/app/src/a.ts:30:thirty",
      "git.example.com/acme/app/src/a.ts-31-31",
      "--",
      "git.example.com/acme/docs/b.md:1:one",
      "git.example.com/acme/docs/b.md-2-two",
    ]);
    expect(output).toMatchObject({ files: 2, matchedLines: 4, truncated: false });
  });

  it("reports truncation when zoekt counted more matches than it returned", () => {
    const file = {
      FileName: "a.ts",
      Repository: "r",
      Content: null,
      LineMatches: [line(1, "x"), line(2, "x")],
    };
    const format = (stats: Partial<ZoektSearchResult>, limit = 100) =>
      formatSearch([result([file], stats)], { context: 0, limit });
    expect(format({}).truncated).toBe(false);
    expect(format({ MatchCount: 3 }).truncated).toBe(true);
    expect(format({ FilesSkipped: 1 }).truncated).toBe(true);
    expect(format({ ShardsSkipped: 1 }).truncated).toBe(true);
    // A second world's file that would pass the limit is dropped, not split.
    const twoWorlds = formatSearch([result([file]), result([{ ...file, Repository: "s" }])], {
      context: 0,
      limit: 3,
    });
    expect(twoWorlds).toMatchObject({ files: 1, matchedLines: 2, truncated: true });
    // zoekt counts lines but cuts its display by fragments: two matches on line 1 used it up.
    const twoFragments = {
      ...line(1, "x x"),
      LineFragments: [
        { LineOffset: 0, MatchLength: 1 },
        { LineOffset: 2, MatchLength: 1 },
      ],
    };
    expect(
      formatSearch([result([{ ...file, LineMatches: [twoFragments] }], { MatchCount: 2 })], {
        context: 0,
        limit: 2,
      }),
    ).toMatchObject({ matchedLines: 1, truncated: true });
  });
});

describe("capLine", () => {
  it("caps long lines at 500 characters and keeps a far match in view", () => {
    const long = `${"a".repeat(900)}MATCH${"b".repeat(900)}`;
    const capped = capLine(long, 900);
    expect(capped.startsWith("…")).toBe(true);
    expect(capped).toContain("MATCH");
    expect(capped.endsWith("… [1805 chars]")).toBe(true);
    expect(capLine("a".repeat(600))).toBe(`${"a".repeat(500)}… [600 chars]`);
    expect(capLine("short")).toBe("short");
  });
});
