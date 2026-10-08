/**
 * Thread find matching. The server and every client compile queries here so a
 * match, and the nth match inside one text, means the same thing everywhere.
 */
import type {
  OrchestrationThreadFindExcerpt,
  OrchestrationThreadFindSource,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";

export interface ThreadFindQuery {
  readonly query: string;
  readonly caseSensitive?: boolean | undefined;
  readonly wholeWord?: boolean | undefined;
  readonly regex?: boolean | undefined;
}

export interface ThreadFindRange {
  readonly start: number;
  readonly end: number;
}

export type ThreadFindMatcher =
  | { readonly _tag: "Valid"; readonly pattern: RegExp }
  | { readonly _tag: "Invalid"; readonly message: string };

const WORD_CHAR = String.raw`[\p{L}\p{M}\p{N}_]`;
const IS_WORD_CHAR = new RegExp(`^${WORD_CHAR}$`, "u");

/**
 * Returns null for an empty query. Literal queries use smart case: they ignore
 * case unless they contain an uppercase letter. Regex queries only match case
 * when asked to. Like VS Code, whole word only adds a boundary on an edge of a
 * literal query that is a word character.
 */
export function compileThreadFind(input: ThreadFindQuery): ThreadFindMatcher | null {
  if (input.query.length === 0) return null;
  let source = input.regex ? input.query : input.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (input.wholeWord) {
    const characters = [...input.query];
    const before = input.regex || IS_WORD_CHAR.test(characters[0]!) ? `(?<!${WORD_CHAR})` : "";
    const after = input.regex || IS_WORD_CHAR.test(characters.at(-1)!) ? `(?!${WORD_CHAR})` : "";
    source = `${before}(?:${source})${after}`;
  }
  const caseSensitive = input.caseSensitive || (!input.regex && /\p{Lu}/u.test(input.query));
  try {
    return { _tag: "Valid", pattern: new RegExp(source, caseSensitive ? "gmu" : "gimu") };
  } catch (error) {
    return { _tag: "Invalid", message: error instanceof Error ? error.message : String(error) };
  }
}

const FENCE = /^\s*(`{3,}|~{3,})/;

// Code spans and escaped characters hide in private-use placeholders while the
// emphasis and link rules run, then come back verbatim. Built from char codes
// so the source never holds invisible characters.
const SPAN_OPEN = String.fromCharCode(0xe000);
const SPAN_CLOSE = String.fromCharCode(0xe001);
const SPAN_PLACEHOLDER = new RegExp(`${SPAN_OPEN}(\\d+)${SPAN_CLOSE}`, "g");
const ESCAPE_BASE = 0xe100;
const ESCAPE_PLACEHOLDER = new RegExp("[\\uE100-\\uE17F]", "g");
const hideEscape = (_: string, char: string) =>
  String.fromCharCode(ESCAPE_BASE + char.charCodeAt(0));

function stripInlineMarkdown(line: string): string {
  const spans: string[] = [];
  const stripped = line
    .replace(/^\s{0,3}(?:> ?)+/, "")
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^(\s*)(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/, "$1")
    // An escaped backtick never opens a code span.
    .replace(/\\(`)/g, hideEscape)
    .replace(/(`+)(.+?)\1(?!`)/g, (_, _ticks: string, code: string) => {
      spans.push(
        code.length > 1 && code.startsWith(" ") && code.endsWith(" ") ? code.slice(1, -1) : code,
      );
      return `${SPAN_OPEN}${spans.length - 1}${SPAN_CLOSE}`;
    })
    .replace(/\\([!-/:-@[-`{-~])/g, hideEscape)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, "$1")
    .replace(/(\*\*|~~)(?=\S)(.*?\S)\1/g, "$2")
    .replace(/(^|[^\p{L}\p{N}_])__(?=\S)(.*?\S)__(?![\p{L}\p{N}_])/gu, "$1$2")
    .replace(/(^|[^\p{L}\p{N}*])\*(?=\S)([^*\n]*?\S)\*(?![\p{L}\p{N}*])/gu, "$1$2")
    .replace(/(^|[^\p{L}\p{N}_])_(?=\S)([^_\n]*?\S)_(?![\p{L}\p{N}_])/gu, "$1$2");
  return stripped
    .replace(ESCAPE_PLACEHOLDER, (char) => String.fromCharCode(char.charCodeAt(0) - ESCAPE_BASE))
    .replace(SPAN_PLACEHOLDER, (_, index: string) => spans[Number(index)] ?? "");
}

/**
 * The text a reader sees in rendered message markdown, so a query typed from
 * the screen matches. Fenced code keeps its content verbatim.
 */
export function threadFindMessageText(markdown: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.split("\n")) {
    const marker = FENCE.exec(line)?.[1];
    if (fence !== null) {
      if (
        marker &&
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        line.trim() === marker
      ) {
        fence = null;
      } else {
        out.push(line);
      }
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }
    out.push(stripInlineMarkdown(line));
  }
  return out.join("\n");
}

export interface ThreadFindItemText {
  /** What clients render for the item. */
  readonly text: string;
  /** Content the wire projection strips, so only the server can search it. */
  readonly detail?: string;
}

function lines(...parts: ReadonlyArray<string | null | undefined>): string {
  return parts
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n");
}

function jsonText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function withDetail(text: string, detail: string | undefined): ThreadFindItemText {
  return detail ? { text, detail } : { text };
}

/**
 * Splits a timeline item into the text a reader sees and the detail only the
 * server keeps. Called with a wire-projected item, `detail` is whatever survived
 * the projection, so clients should only search `text`.
 */
export function threadFindItemText(item: OrchestrationV2TurnItem): ThreadFindItemText {
  switch (item.type) {
    case "user_message":
    case "assistant_message":
    case "reasoning":
      return { text: threadFindMessageText(item.text) };
    case "proposed_plan":
      return { text: threadFindMessageText(item.markdown) };
    // Task lists and checkpoints show in the composer, not the timeline.
    case "todo_list":
    case "checkpoint":
      return { text: "" };
    case "command_execution":
      return withDetail(lines(item.title, item.input), item.output);
    case "file_change":
      return withDetail(
        lines(
          item.title,
          ...new Set([item.fileName, ...(item.changes ?? []).map((change) => change.path)]),
        ),
        item.diffStr ?? item.newStr,
      );
    case "file_search":
      return { text: lines(item.title, item.pattern) };
    case "web_search":
      return { text: lines(item.title, ...(item.patterns ?? [])) };
    case "dynamic_tool":
      return withDetail(
        lines(item.title, item.toolName),
        lines(jsonText(item.input), jsonText(item.output)),
      );
    case "approval_request":
      return { text: lines(item.title, item.prompt) };
    case "user_input_request":
      return {
        text: lines(
          item.title,
          ...item.questions.flatMap((question) => [
            question.header,
            question.question,
            ...question.options.map((option) => option.label),
          ]),
        ),
      };
    case "notification":
      return { text: lines(item.summary, item.detail) };
    case "system_notice":
    case "run_interrupt_request":
    case "run_interrupt_result":
      return { text: item.message };
    case "error":
      return { text: item.failure.message };
    case "compaction":
      return { text: lines(item.summary) };
    case "subagent":
      return { text: lines(item.prompt, item.progress, item.result) };
    case "handoff":
      return withDetail("", item.summary);
    case "fork":
    case "thread_created":
      return { text: "" };
  }
}

export function threadFindItemSource(item: OrchestrationV2TurnItem): OrchestrationThreadFindSource {
  switch (item.type) {
    case "user_message":
      return "user";
    case "assistant_message":
    case "proposed_plan":
      return "assistant";
    case "reasoning":
      return "reasoning";
    default:
      return "tool";
  }
}

/** Non-empty matches in order, so an index into the result is a stable occurrence. */
export function findThreadMatches(
  matcher: Extract<ThreadFindMatcher, { _tag: "Valid" }>,
  text: string,
  limit = Number.POSITIVE_INFINITY,
): ThreadFindRange[] {
  const ranges: ThreadFindRange[] = [];
  if (limit <= 0) return ranges;
  for (const match of text.matchAll(matcher.pattern)) {
    if (match[0].length === 0) continue;
    ranges.push({ start: match.index, end: match.index + match[0].length });
    if (ranges.length >= limit) break;
  }
  return ranges;
}

export interface ThreadFindExcerptOptions {
  /** Lines of context kept on each side of the matching lines. */
  readonly contextLines: 0 | 1;
  readonly maxChars: number;
  /** Length of the whole field when the searched text is only its prefix. */
  readonly totalLength?: number | undefined;
}

/** A one-line snippet for lists, where only the matching line matters. */
export const THREAD_FIND_TEXT_EXCERPT = { contextLines: 0, maxChars: 160 } as const;
/** Lines shown in place of output the client never received. */
export const THREAD_FIND_DETAIL_EXCERPT = { contextLines: 1, maxChars: 400 } as const;

/**
 * The lines around each match, trimmed around the match when they run long.
 * Ranges must be in order: lines are counted in one pass, so long single-line
 * output costs no rescans.
 */
export function threadFindExcerpts(
  text: string,
  ranges: ReadonlyArray<ThreadFindRange>,
  options: ThreadFindExcerptOptions,
): OrchestrationThreadFindExcerpt[] {
  let line = 1;
  let lineStart = 0;
  let previousLineStart = 0;
  let nextBreak = text.indexOf("\n");
  let followingBreakFor = -1;
  let followingBreak = -1;
  return ranges.map(({ start, end }) => {
    while (nextBreak !== -1 && nextBreak < start) {
      line += 1;
      previousLineStart = lineStart;
      lineStart = nextBreak + 1;
      nextBreak = text.indexOf("\n", lineStart);
    }
    // A match can span lines; the excerpt runs to the end of its last line.
    const lastBreak = nextBreak !== -1 && nextBreak < end ? text.indexOf("\n", end) : nextBreak;
    let from = options.contextLines > 0 ? previousLineStart : lineStart;
    let to = text.length;
    if (lastBreak !== -1 && options.contextLines === 0) to = lastBreak;
    if (lastBreak !== -1 && options.contextLines > 0) {
      if (followingBreakFor !== lastBreak) {
        followingBreakFor = lastBreak;
        followingBreak = text.indexOf("\n", lastBreak + 1);
      }
      to = followingBreak === -1 ? text.length : followingBreak;
    }
    if (to - from > options.maxChars) {
      const room = Math.max(0, options.maxChars - (end - start));
      from = Math.max(from, start - Math.floor(room / 2));
      to = Math.min(to, from + options.maxChars);
    }
    return {
      text: text.slice(from, to),
      start: start - from,
      end: Math.min(end, to) - from,
      line,
      ...(options.totalLength === undefined ? {} : { totalLength: options.totalLength }),
    };
  });
}
