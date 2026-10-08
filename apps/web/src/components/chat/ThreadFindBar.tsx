import { THREAD_FIND_SCOPES, type ThreadFindScope } from "@t3tools/client-runtime/thread-find";
import type { OrchestrationThreadFindSource } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  ListIcon,
  SearchIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { useThreadFindStore } from "~/threadFindStore";

import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { threadFindSnippet } from "./threadFind.logic";
import type { ThreadFindController } from "./useThreadFind";

const SCOPE_LABEL: Record<ThreadFindScope, string> = {
  all: "All",
  user: "You",
  assistant: "Agent",
  tool: "Tools",
  reasoning: "Thinking",
};
const SOURCE_LABEL: Record<OrchestrationThreadFindSource, string> = {
  user: "You",
  assistant: "Agent",
  tool: "Tool",
  reasoning: "Thinking",
};
const LIST_LIMIT = 300;
const WRAP_NOTICE_MS = 1200;

function OptionToggle(props: {
  readonly active: boolean;
  readonly label: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            aria-label={props.label}
            pressed={props.active}
            size="segmented"
            variant="segmented"
            onClick={props.onClick}
          />
        }
      >
        <span className="font-mono">{props.children}</span>
      </TooltipTrigger>
      <TooltipPopup side="bottom">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

function IconButton(props: {
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly pressed?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={props.label}
            aria-pressed={props.pressed}
            disabled={props.disabled}
            onClick={props.onClick}
            className={cn(
              "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
              props.pressed && "bg-accent text-foreground",
            )}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

function useWrapNotice(at: number | null) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (at === null) return;
    setVisible(true);
    const timer = window.setTimeout(() => setVisible(false), WRAP_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [at]);
  return visible;
}

function counterText(find: ThreadFindController): { text: string; tone: "muted" | "error" } {
  const { results, index, pending } = find;
  if (results.invalid !== null) return { text: "Invalid regex", tone: "error" };
  if (find.query.query.length === 0) return { text: "", tone: "muted" };
  const total = `${results.matches.length}${results.truncated ? "+" : ""}`;
  if (results.matches.length === 0) {
    return pending ? { text: "Searching", tone: "muted" } : { text: "No results", tone: "error" };
  }
  return index < 0
    ? { text: `${total} found`, tone: "muted" }
    : { text: `${index + 1} of ${total}`, tone: "muted" };
}

/** Find in the open thread: the bar, its options and the match list. */
export function ThreadFindBar(props: {
  readonly find: ThreadFindController;
  readonly onSearchAllThreads?: ((query: string) => void) | undefined;
}) {
  const { find } = props;
  const query = useThreadFindStore((state) => state.query);
  const caseSensitive = useThreadFindStore((state) => state.caseSensitive);
  const wholeWord = useThreadFindStore((state) => state.wholeWord);
  const regex = useThreadFindStore((state) => state.regex);
  const scope = useThreadFindStore((state) => state.scope);
  const listOpen = useThreadFindStore((state) => state.listOpen);
  const focusRequest = useThreadFindStore((state) => state.focusRequest);
  const setQuery = useThreadFindStore((state) => state.setQuery);
  const toggleOption = useThreadFindStore((state) => state.toggleOption);
  const setScope = useThreadFindStore((state) => state.setScope);
  const toggleList = useThreadFindStore((state) => state.toggleList);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const wrapped = useWrapNotice(find.wrapNoticeAt);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusRequest]);

  // Keep the selected row visible without scrolling the page around it.
  useEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!list || !row) return;
    const listBox = list.getBoundingClientRect();
    const rowBox = row.getBoundingClientRect();
    if (rowBox.top < listBox.top + 24) list.scrollTop -= listBox.top + 24 - rowBox.top;
    else if (rowBox.bottom > listBox.bottom) list.scrollTop += rowBox.bottom - listBox.bottom;
  }, [find.index, listOpen]);

  const matches = find.results.matches;
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      find.step(event.shiftKey ? "newer" : "older");
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      find.close();
    } else if (listOpen && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      if (matches.length === 0) return;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      find.pick((Math.max(find.index, 0) + delta + matches.length) % matches.length);
    } else if (
      event.altKey &&
      (event.code === "KeyC" || event.code === "KeyW" || event.code === "KeyR")
    ) {
      event.preventDefault();
      toggleOption(
        event.code === "KeyC" ? "caseSensitive" : event.code === "KeyW" ? "wholeWord" : "regex",
      );
    }
  };

  const counter = counterText(find);
  const listed = matches.slice(0, LIST_LIMIT).map((match, matchIndex) => ({
    match,
    matchIndex,
    group: find.groupLabel(match),
  }));

  return (
    <div
      role="search"
      aria-label="Find in thread"
      className="pointer-events-auto absolute top-2 right-4 z-30 flex w-[min(32rem,calc(100%-2rem))] flex-col gap-1.5 rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-lg"
    >
      <div className="flex items-center gap-1">
        <label
          className={cn(
            "flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border bg-background px-2 focus-within:border-ring",
            counter.tone === "error" && "border-destructive/70 focus-within:border-destructive",
          )}
        >
          <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Find in thread"
            aria-label="Find in thread"
            spellCheck={false}
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <span
            className={cn(
              "flex shrink-0 items-center gap-1.5 text-xs tabular-nums",
              wrapped
                ? "text-warning"
                : counter.tone === "error"
                  ? "text-destructive"
                  : "text-muted-foreground",
            )}
            aria-live="polite"
          >
            {wrapped ? "Wrapped" : counter.text}
            {find.pending && counter.text.length > 0 && !wrapped ? (
              <span
                role="status"
                aria-label="Searching the rest of the thread"
                className="inline-block size-1.5 rounded-full border border-muted-foreground"
              />
            ) : null}
          </span>
        </label>
        <div className="flex items-center gap-0.5 rounded-md border bg-muted/30 p-0.5">
          <OptionToggle
            active={caseSensitive}
            label="Match case (Alt+C)"
            onClick={() => toggleOption("caseSensitive")}
          >
            Aa
          </OptionToggle>
          <OptionToggle
            active={wholeWord}
            label="Match whole word (Alt+W)"
            onClick={() => toggleOption("wholeWord")}
          >
            <span className="underline decoration-2 underline-offset-2">ab</span>
          </OptionToggle>
          <OptionToggle
            active={regex}
            label="Use regular expression (Alt+R)"
            onClick={() => toggleOption("regex")}
          >
            .*
          </OptionToggle>
        </div>
        <IconButton
          label="Older match (Enter)"
          disabled={matches.length === 0}
          onClick={() => find.step("older")}
        >
          <ChevronUpIcon className="size-4" />
        </IconButton>
        <IconButton
          label="Newer match (Shift+Enter)"
          disabled={matches.length === 0}
          onClick={() => find.step("newer")}
        >
          <ChevronDownIcon className="size-4" />
        </IconButton>
        <IconButton label="All matches" pressed={listOpen} onClick={toggleList}>
          <ListIcon className="size-4" />
        </IconButton>
        <IconButton label="Close (Esc)" onClick={find.close}>
          <XIcon className="size-4" />
        </IconButton>
      </div>
      <div className="flex flex-wrap items-center gap-1 px-0.5">
        {THREAD_FIND_SCOPES.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={scope === option}
            onClick={() => setScope(option)}
            className={cn(
              "h-5.5 rounded-full border px-2 text-xs text-muted-foreground",
              scope === option && "border-primary/50 bg-primary/15 text-foreground",
              find.results.counts[option] === 0 && scope !== option && "opacity-50",
            )}
          >
            {SCOPE_LABEL[option]}
            {query.length > 0 ? (
              <span className="ms-1 tabular-nums opacity-70">{find.results.counts[option]}</span>
            ) : null}
          </button>
        ))}
        {find.regexLocalOnly ? (
          <span className="ms-auto text-2xs text-muted-foreground">
            Regex searches loaded messages only
          </span>
        ) : null}
      </div>
      {listOpen && query.length > 0 ? (
        <div
          ref={listRef}
          className="-mx-1.5 -mb-1.5 max-h-80 overflow-y-auto border-t px-1.5 py-1 text-xs"
        >
          {listed.map(({ match, matchIndex, group }) => {
            const header =
              matchIndex === 0 || listed[matchIndex - 1]?.group !== group ? (
                <div className="sticky top-0 truncate bg-popover px-2 pt-1.5 pb-0.5 text-2xs text-muted-foreground">
                  {group}
                </div>
              ) : null;
            const snippet = threadFindSnippet(match.excerpt);
            return (
              <div key={match.key}>
                {header}
                <button
                  type="button"
                  aria-current={matchIndex === find.index}
                  onClick={() => find.pick(matchIndex)}
                  className={cn(
                    "flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left hover:bg-accent",
                    matchIndex === find.index && "bg-primary/15",
                  )}
                >
                  <span className="w-16 shrink-0 truncate text-2xs text-muted-foreground">
                    {SOURCE_LABEL[match.source]}
                    {match.field === "detail" ? ", output" : ""}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate",
                      !match.loaded && "text-muted-foreground",
                    )}
                  >
                    {snippet.before}
                    <mark className="rounded-xs bg-warning/30 text-foreground">
                      {snippet.match}
                    </mark>
                    {snippet.after}
                  </span>
                </button>
              </div>
            );
          })}
          {matches.length > LIST_LIMIT ? (
            <p className="px-2 py-1.5 text-2xs text-muted-foreground">
              {matches.length - LIST_LIMIT} more. Narrow the query or pick a scope.
            </p>
          ) : null}
          {matches.length === 0 ? (
            <p className="px-2 py-3 text-muted-foreground">
              {find.pending ? "Searching the thread" : "No matches in this thread."}
            </p>
          ) : null}
          {props.onSearchAllThreads ? (
            <button
              type="button"
              onClick={() => props.onSearchAllThreads?.(query)}
              className="mt-1 flex w-full rounded-md border-t px-2 py-1.5 text-left text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              Search all threads for "{query}"
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** After a long jump, closing find offers the way back for a few seconds. */
export function ThreadFindBackPill(props: { readonly find: ThreadFindController }) {
  if (!props.find.showBack) return null;
  return (
    <button
      type="button"
      onClick={props.find.goBack}
      className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full border bg-popover px-3 py-1 text-xs text-popover-foreground shadow-md hover:bg-accent"
    >
      <Undo2Icon className="size-3.5" aria-hidden />
      Back to where you were
    </button>
  );
}
