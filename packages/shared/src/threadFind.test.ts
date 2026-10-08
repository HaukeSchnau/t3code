import { describe, expect, it } from "vite-plus/test";
import {
  compileThreadFind,
  findThreadMatches,
  THREAD_FIND_DETAIL_EXCERPT,
  THREAD_FIND_TEXT_EXCERPT,
  threadFindExcerpts,
  threadFindItemSource,
  threadFindItemText,
  threadFindMessageText,
  type ThreadFindQuery,
} from "./threadFind.ts";
import { MessageId, ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const at = DateTime.makeUnsafe(Date.UTC(2026, 9, 8));
const base = {
  id: TurnItemId.make("item"),
  threadId: ThreadId.make("thread"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "completed",
  title: null,
  startedAt: at,
  completedAt: at,
  updatedAt: at,
} as const;

describe("threadFindItemText", () => {
  it("keeps stripped tool content in detail", () => {
    const command: OrchestrationV2TurnItem = {
      ...base,
      type: "command_execution",
      title: "Run tests",
      input: "vp test run",
      output: "1 failed",
    };
    expect(threadFindItemText(command)).toEqual({
      text: "Run tests\nvp test run",
      detail: "1 failed",
    });
    expect(threadFindItemSource(command)).toBe("tool");

    const change: OrchestrationV2TurnItem = {
      ...base,
      type: "file_change",
      fileName: "a.ts",
      diffStr: "+const a = 1;",
      changes: [
        { operation: "update", path: "a.ts" },
        { operation: "add", path: "b.ts" },
      ],
    };
    expect(threadFindItemText(change)).toEqual({ text: "a.ts\nb.ts", detail: "+const a = 1;" });
  });

  it("matches messages as rendered and labels their source", () => {
    const answer: OrchestrationV2TurnItem = {
      ...base,
      type: "assistant_message",
      messageId: MessageId.make("message"),
      text: "Use `probe()`",
      streaming: false,
    };
    expect(threadFindItemText(answer)).toEqual({ text: "Use probe()" });
    expect(threadFindItemSource(answer)).toBe("assistant");
  });
});

describe("threadFindMessageText", () => {
  it("keeps what a reader sees in inline markdown", () => {
    expect(
      threadFindMessageText(
        "Moved to the `close` listener in **RelayClient**, see [the docs](https://x.dev) and *why*.",
      ),
    ).toBe("Moved to the close listener in RelayClient, see the docs and why.");
    expect(threadFindMessageText("Use `` a`b `` and \\*literal\\* stars")).toBe(
      "Use a`b and *literal* stars",
    );
    expect(threadFindMessageText("Code `**kept**` and `[x](y)` stay raw")).toBe(
      "Code **kept** and [x](y) stay raw",
    );
    expect(threadFindMessageText("costs \\$5, use \\`x\\` and __bold__")).toBe(
      "costs $5, use `x` and bold",
    );
  });

  it("leaves identifiers with underscores and stars alone", () => {
    expect(threadFindMessageText("probe_timeout_ms and 2*3*4 stay")).toBe(
      "probe_timeout_ms and 2*3*4 stay",
    );
    expect(threadFindMessageText("foo__bar__baz")).toBe("foo__bar__baz");
  });

  it("drops block markers but keeps fenced code verbatim", () => {
    const markdown = [
      "## Plan",
      "> quoted **text**",
      "1. first `step`",
      "- [x] done",
      "```ts",
      "const a = `**not bold**`;",
      "```",
      "after",
      "10. nested",
      "    ```py",
      "    def __init__(self):",
      "    ```",
    ].join("\n");
    expect(threadFindMessageText(markdown)).toBe(
      [
        "Plan",
        "quoted text",
        "first step",
        "done",
        "const a = `**not bold**`;",
        "after",
        "nested",
        "    def __init__(self):",
      ].join("\n"),
    );
  });
});

function find(query: ThreadFindQuery, text: string, limit?: number) {
  const matcher = compileThreadFind(query);
  if (matcher?._tag !== "Valid") throw new Error(`expected a valid matcher for ${query.query}`);
  return findThreadMatches(matcher, text, limit).map(({ start, end }) => text.slice(start, end));
}

describe("compileThreadFind", () => {
  it("returns null for an empty query and reports invalid regex", () => {
    expect(compileThreadFind({ query: "" })).toBeNull();
    expect(compileThreadFind({ query: "probe(", regex: true })).toMatchObject({ _tag: "Invalid" });
    expect(compileThreadFind({ query: "probe(" })).toMatchObject({ _tag: "Valid" });
  });
});

describe("findThreadMatches", () => {
  it("uses smart case for literal queries", () => {
    const text = "Probe the probe, then PROBE again";
    expect(find({ query: "probe" }, text)).toEqual(["Probe", "probe", "PROBE"]);
    expect(find({ query: "Probe" }, text)).toEqual(["Probe"]);
    expect(find({ query: "probe", caseSensitive: true }, text)).toEqual(["probe"]);
  });

  it("folds case beyond ASCII", () => {
    expect(find({ query: "ärger" }, "ÄRGER und Ärger")).toEqual(["ÄRGER", "Ärger"]);
    expect(find({ query: "Ärger" }, "ÄRGER und Ärger")).toEqual(["Ärger"]);
  });

  it("matches literal queries literally", () => {
    expect(find({ query: "a.b" }, "axb a.b")).toEqual(["a.b"]);
    expect(find({ query: "(x)" }, "f(x) - y")).toEqual(["(x)"]);
  });

  it("treats letters in any script as word characters for whole word", () => {
    const text = "probe() probeTimeoutMs re-probe _probe";
    expect(find({ query: "probe", wholeWord: true }, text)).toEqual(["probe", "probe"]);
    expect(find({ query: "café", wholeWord: true }, "cafés café.")).toEqual(["café"]);
    // Edges that are not word characters need no boundary, like VS Code.
    expect(find({ query: "(x)", wholeWord: true }, "f(x) - g(x)y")).toEqual(["(x)", "(x)"]);
  });

  it("runs regex queries per line and skips empty matches", () => {
    expect(find({ query: String.raw`\d+ms`, regex: true }, "took 41ms, then 212ms")).toEqual([
      "41ms",
      "212ms",
    ]);
    expect(find({ query: "^ ✓", regex: true }, " ✓ one\n ✗ two\n ✓ three")).toEqual([" ✓", " ✓"]);
    expect(find({ query: "x*", regex: true }, "axxbx")).toEqual(["xx", "x"]);
  });

  it("stops at the limit", () => {
    expect(find({ query: "a" }, "aaaa", 2)).toEqual(["a", "a"]);
    expect(find({ query: "a" }, "aaaa", 0)).toEqual([]);
  });
});

describe("threadFindExcerpts", () => {
  const ranges = (query: ThreadFindQuery, text: string) => {
    const matcher = compileThreadFind(query);
    if (matcher?._tag !== "Valid") throw new Error("expected a valid matcher");
    return findThreadMatches(matcher, text);
  };

  it("keeps the matching line, or the lines around it for detail", () => {
    const text = "first\nsecond probe line\nthird\nfourth probe";
    const found = ranges({ query: "probe" }, text);
    const [middle, last] = threadFindExcerpts(text, found, THREAD_FIND_DETAIL_EXCERPT);
    expect(middle).toMatchObject({ text: "first\nsecond probe line\nthird", line: 2 });
    expect(middle!.text.slice(middle!.start, middle!.end)).toBe("probe");
    expect(last).toMatchObject({ text: "third\nfourth probe", line: 4 });
    const [snippet] = threadFindExcerpts(text, found, THREAD_FIND_TEXT_EXCERPT);
    expect(snippet).toMatchObject({ text: "second probe line", line: 2 });
  });

  it("never starts before the text when a match begins at a line break", () => {
    const text = "\nfoo bar";
    const [excerpt] = threadFindExcerpts(
      text,
      ranges({ query: "\\s+foo", regex: true }, text),
      THREAD_FIND_DETAIL_EXCERPT,
    );
    expect(excerpt).toMatchObject({ start: 0, end: 4, line: 1 });
  });

  it("trims long lines around the match", () => {
    const long = `${"a".repeat(2000)} probe ${"b".repeat(2000)}`;
    const [excerpt] = threadFindExcerpts(long, ranges({ query: "probe" }, long), {
      ...THREAD_FIND_DETAIL_EXCERPT,
      totalLength: 9000,
    });
    expect(excerpt!.text.length).toBe(400);
    expect(excerpt!.text.slice(excerpt!.start, excerpt!.end)).toBe("probe");
    expect(excerpt!.totalLength).toBe(9000);
  });
});
