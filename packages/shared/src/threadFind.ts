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

/**
 * Returns null for an empty query. Literal queries use smart case: they ignore
 * case unless they contain an uppercase letter. Regex queries only match case
 * when asked to.
 */
export function compileThreadFind(input: ThreadFindQuery): ThreadFindMatcher | null {
  if (input.query.length === 0) return null;
  let source = input.regex ? input.query : input.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (input.wholeWord) source = `(?<!${WORD_CHAR})(?:${source})(?!${WORD_CHAR})`;
  const caseSensitive = input.caseSensitive || (!input.regex && /\p{Lu}/u.test(input.query));
  try {
    return { _tag: "Valid", pattern: new RegExp(source, caseSensitive ? "gmu" : "gimu") };
  } catch (error) {
    return { _tag: "Invalid", message: error instanceof Error ? error.message : String(error) };
  }
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

// Code spans and escaped characters hide in private-use placeholders while the
// emphasis and link rules run, then come back verbatim.
const ESCAPE_BASE = 0xe100;

function stripInlineMarkdown(line: string): string {
  const spans: string[] = [];
  const stripped = line
    .replace(/^ {0,3}(?:> ?)+/, "")
    .replace(/^ {0,3}#{1,6}\s+/, "")
    .replace(/^(\s*)(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/, "$1")
    .replace(/(`+)(.+?)\1(?!`)/g, (_, _ticks: string, code: string) => {
      spans.push(
        code.length > 1 && code.startsWith(" ") && code.endsWith(" ") ? code.slice(1, -1) : code,
      );
      return `${spans.length - 1}`;
    })
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~<])/g, (_, char: string) =>
      String.fromCharCode(ESCAPE_BASE + char.charCodeAt(0)),
    )
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, "$1")
    .replace(/(\*\*|__|~~)(?=\S)(.*?\S)\1/g, "$2")
    .replace(/(^|[^\p{L}\p{N}*])\*(?=\S)([^*\n]*?\S)\*(?![\p{L}\p{N}*])/gu, "$1$2")
    .replace(/(^|[^\p{L}\p{N}_])_(?=\S)([^_\n]*?\S)_(?![\p{L}\p{N}_])/gu, "$1$2");
  return stripped
    .replace(/[-]/g, (char) => String.fromCharCode(char.charCodeAt(0) - ESCAPE_BASE))
    .replace(/(\d+)/g, (_, index: string) => spans[Number(index)] ?? "");
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
    case "todo_list":
      return { text: lines(item.explanation, ...item.steps.map((step) => step.text)) };
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
    case "checkpoint":
      return { text: lines(item.title, ...item.files.map((file) => file.path)) };
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

const EXCERPT_CHARS = 600;

/**
 * The lines around each match: the line before, the matching lines and the
 * line after, trimmed around the match when they run long. Ranges must be in
 * order, so line numbers are counted once per text.
 */
export function threadFindExcerpts(
  text: string,
  ranges: ReadonlyArray<ThreadFindRange>,
  totalLength?: number,
): OrchestrationThreadFindExcerpt[] {
  let line = 1;
  let counted = 0;
  return ranges.map(({ start, end }) => {
    for (let index = text.indexOf("\n", counted); index !== -1 && index < start;) {
      line += 1;
      counted = index + 1;
      index = text.indexOf("\n", counted);
    }
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    let from = lineStart > 0 ? text.lastIndexOf("\n", lineStart - 2) + 1 : 0;
    const lineEnd = text.indexOf("\n", end);
    const nextEnd = lineEnd === -1 ? -1 : text.indexOf("\n", lineEnd + 1);
    let to = lineEnd === -1 || nextEnd === -1 ? text.length : nextEnd;
    if (to - from > EXCERPT_CHARS) {
      const room = Math.max(0, EXCERPT_CHARS - (end - start));
      from = Math.max(from, start - Math.floor(room / 2));
      to = Math.min(to, from + EXCERPT_CHARS);
    }
    return {
      text: text.slice(from, to),
      start: start - from,
      end: Math.min(end, to) - from,
      line,
      ...(totalLength === undefined ? {} : { totalLength }),
    };
  });
}
