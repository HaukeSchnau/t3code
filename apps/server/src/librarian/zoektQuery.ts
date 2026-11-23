import * as Schema from "effect/Schema";

const LINE_CAP = 500;
const LONG_LINE_LEAD = 100;

/** The whole content zoekt (a0f5789) stores, and matches, in place of a file it skipped. */
const SKIPPED_BODIES = [
  "exceeds the maximum size limit",
  "contains too few trigrams",
  "contains binary content",
  "contains too many trigrams",
  "object missing from repository",
].map((reason) => `NOT-INDEXED: ${reason}`);

const quoteRegex = (text: string) => text.replace(/[\\.+*?()|[\]{}^$]/g, "\\$&");

/** zoekt's quoted argument passes any RE2 through once backslashes and quotes are escaped. */
const regexToken = (regex: string) => `"${regex.replace(/[\\"]/g, "\\$&")}"`;

/**
 * Like `git grep -F`, where each line of the pattern is its own pattern, except
 * that a blank line does not match every line. zoekt splits terms on whitespace
 * and reads `"` as query syntax.
 */
const literalToken = (text: string) =>
  text
    .split("\n")
    .filter((line) => line !== "")
    .map(quoteRegex)
    .join("|")
    .replaceAll('"', "\\x22")
    .replaceAll(" ", "\\x20")
    .replaceAll("\t", "\\t")
    .replaceAll("\r", "\\r");

// Scoped so `ignoreCase` cannot widen it to real files.
const SKIPPED_EXCLUSION = `(case:yes -content:${regexToken(String.raw`\A(${SKIPPED_BODIES.map(quoteRegex).join("|")})\z`)})`;

/** t3code vendors references under `.repos/`; rg skips it as a hidden directory, zoekt indexes it. */
const VENDORED_EXCLUSIONS = [
  String.raw`-file:^\.repos/`,
  String.raw`-file:(^|/)node_modules/`,
  String.raw`-file:(-lock\.[^/]*|\.lock)$`,
];

export interface SearchQueryInput {
  readonly pattern: string;
  readonly regex?: boolean | undefined;
  readonly ignoreCase?: boolean | undefined;
  readonly repo?: string | undefined;
  readonly path?: string | undefined;
  readonly includeVendored?: boolean | undefined;
}

export const searchQuery = (input: SearchQueryInput) =>
  [
    input.ignoreCase ? "case:no" : "case:yes",
    ...(input.repo ? [`repo:${regexToken(input.repo)}`] : []),
    ...(input.path ? [`file:${regexToken(input.path)}`] : []),
    SKIPPED_EXCLUSION,
    ...(input.includeVendored ? [] : VENDORED_EXCLUSIONS),
    `content:${input.regex ? regexToken(input.pattern) : literalToken(input.pattern)}`,
  ].join(" ");

export const wholeFileQuery = (repo: string, path: string) =>
  `repo:${regexToken(`^${quoteRegex(repo)}$`)} file:${regexToken(`^${quoteRegex(path)}$`)}`;

const Base64Text = Schema.optional(Schema.NullOr(Schema.String));

export const ZoektLineMatch = Schema.Struct({
  Line: Base64Text,
  LineNumber: Schema.Number,
  Before: Base64Text,
  After: Base64Text,
  FileName: Schema.Boolean,
  LineFragments: Schema.optional(
    Schema.NullOr(
      Schema.Array(Schema.Struct({ LineOffset: Schema.Number, MatchLength: Schema.Number })),
    ),
  ),
});

export const ZoektFileMatch = Schema.Struct({
  FileName: Schema.String,
  Repository: Schema.String,
  Version: Schema.optional(Schema.String),
  Branches: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  Content: Base64Text,
  LineMatches: Schema.optional(Schema.NullOr(Schema.Array(ZoektLineMatch))),
});
export type ZoektFileMatch = typeof ZoektFileMatch.Type;

export const ZoektSearchReply = Schema.Struct({
  Result: Schema.Struct({
    FileCount: Schema.Number,
    MatchCount: Schema.Number,
    FilesSkipped: Schema.Number,
    ShardsSkipped: Schema.Number,
    Files: Schema.optional(Schema.NullOr(Schema.Array(ZoektFileMatch))),
  }),
});
export type ZoektSearchResult = (typeof ZoektSearchReply.Type)["Result"];

export const ZoektListReply = Schema.Struct({
  List: Schema.Struct({
    Repos: Schema.optional(
      Schema.NullOr(
        Schema.Array(
          Schema.Struct({
            Repository: Schema.Struct({
              Name: Schema.String,
              Branches: Schema.optional(
                Schema.NullOr(Schema.Array(Schema.Struct({ Name: Schema.String }))),
              ),
            }),
          }),
        ),
      ),
    ),
  }),
});

export const ZoektErrorReply = Schema.Struct({ Error: Schema.String });

const decodeBase64 = (value: string | null | undefined) =>
  value ? Buffer.from(value, "base64") : Buffer.alloc(0);

const splitLines = (bytes: Buffer) => {
  const text = bytes.toString("utf8");
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
};

/**
 * Caps a line at 500 characters like `rg -M 500`, but keeps the first match
 * in view: minified lines put it far past the cap.
 */
export const capLine = (line: string, matchStart = 0) => {
  if (line.length <= LINE_CAP) return line;
  const start = matchStart + LONG_LINE_LEAD > LINE_CAP ? matchStart - LONG_LINE_LEAD : 0;
  const end = start + LINE_CAP;
  return `${start > 0 ? "…" : ""}${line.slice(start, end)}… [${line.length} chars]`;
};

const charOffset = (lineBytes: Buffer, byteOffset: number) =>
  lineBytes.subarray(0, byteOffset).toString("utf8").length;

interface OutputLine {
  readonly text: string;
  readonly match: boolean;
}

/** rg's non-tty format: `path:line:text` for matches, `path-line-text` for context, `--` between groups. */
const formatFile = (file: ZoektFileMatch, withContext: boolean) => {
  const lines = new Map<number, OutputLine>();
  for (const lineMatch of file.LineMatches ?? []) {
    if (lineMatch.FileName) continue;
    const lineBytes = decodeBase64(lineMatch.Line);
    const fragment = lineMatch.LineFragments?.[0];
    const matchStart = fragment ? charOffset(lineBytes, fragment.LineOffset) : 0;
    splitLines(lineBytes).forEach((text, offset) =>
      lines.set(lineMatch.LineNumber + offset, {
        text: capLine(text, offset === 0 ? matchStart : 0),
        match: true,
      }),
    );
    const before = splitLines(decodeBase64(lineMatch.Before));
    before.forEach((text, offset) => {
      const number = lineMatch.LineNumber - before.length + offset;
      if (!lines.has(number)) lines.set(number, { text: capLine(text), match: false });
    });
    splitLines(decodeBase64(lineMatch.After)).forEach((text, offset) => {
      const number = lineMatch.LineNumber + 1 + offset;
      if (!lines.has(number)) lines.set(number, { text: capLine(text), match: false });
    });
  }
  const name = `${file.Repository}/${file.FileName}`;
  const out: Array<string> = [];
  let matches = 0;
  let previous: number | undefined;
  for (const number of [...lines.keys()].toSorted((a, b) => a - b)) {
    if (withContext && previous !== undefined && number !== previous + 1) out.push("--");
    const line = lines.get(number)!;
    const mark = line.match ? ":" : "-";
    out.push(`${name}${mark}${number}${mark}${line.text}`);
    if (line.match) matches++;
    previous = number;
  }
  return { lines: out, matches };
};

export interface SearchOutput {
  readonly output: string;
  readonly files: number;
  readonly matchedLines: number;
  readonly truncated: boolean;
}

/** Results from several worlds, in world order; each world's files keep zoekt's ranking. */
export const formatSearch = (
  results: ReadonlyArray<ZoektSearchResult>,
  options: { readonly context: number; readonly limit: number },
): SearchOutput => {
  const blocks: Array<Array<string>> = [];
  let matchedLines = 0;
  let truncated = false;
  worlds: for (const result of results) {
    const returned = result.Files ?? [];
    // MatchCount counts lines; MaxMatchDisplayCount cuts by fragments, so compare lines.
    const lineMatches = returned.reduce(
      (sum, file) => sum + (file.LineMatches ?? []).filter((line) => !line.FileName).length,
      0,
    );
    if (result.MatchCount > lineMatches || result.FilesSkipped > 0 || result.ShardsSkipped > 0)
      truncated = true;
    for (const file of returned) {
      const { lines, matches } = formatFile(file, options.context > 0);
      if (lines.length === 0) continue;
      if (matchedLines + matches > options.limit) {
        truncated = true;
        break worlds;
      }
      blocks.push(lines);
      matchedLines += matches;
    }
  }
  return {
    output: blocks.map((lines) => lines.join("\n")).join(options.context > 0 ? "\n--\n" : "\n"),
    files: blocks.length,
    matchedLines,
    truncated,
  };
};

/** The placeholder zoekt returns for a file it skipped, or undefined for an indexed file. */
export const skippedReason = (content: Buffer) => {
  if (content.length > 100) return undefined;
  const text = content.toString("utf8");
  return SKIPPED_BODIES.includes(text) ? text : undefined;
};

export const decodeContent = decodeBase64;
