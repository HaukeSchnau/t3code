/**
 * Compare: an opt-in mode inside Work over the selected workers.
 *
 * Lenses come from what each column actually has: Answer always, Diff, Files,
 * Preview and Terminal when at least one column offers them. Diff renders
 * through the same parser and virtualized viewer the pull request tab uses.
 * Preview embeds the thread's real preview panel. Terminal links into the
 * thread rather than imitating a terminal.
 */
import { TurnId, type ScopedThreadRef } from "@t3tools/contracts";
import type { CodeViewDiffItem } from "@pierre/diffs";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ExternalLink, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { getRenderablePatch, resolveDiffThemeName } from "../../lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "../../lib/syntaxHighlighting";
import { useTheme } from "../../hooks/useTheme";
import { useRightPanelStore } from "../../rightPanelStore";
import { cn } from "~/lib/utils";
import { ChangedFilesTree } from "../chat/ChangedFilesTree";
import ChatMarkdown from "../ChatMarkdown";
import { StyledDiffCodeView } from "../diffs/StyledDiffCodeView";
import { Button } from "../ui/button";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { useCompareColumnHook, type CompareColumnData } from "./compareData";
import { useWorkPanelStore, type CompareLens } from "./workPanelStore";
import { workerStateVisual } from "./workPresentation";

const LENS_ORDER: ReadonlyArray<CompareLens> = ["answer", "diff", "files", "preview", "terminal"];
const LENS_LABELS: Record<CompareLens, string> = {
  answer: "Answer",
  diff: "Diff",
  files: "Files",
  preview: "Preview",
  terminal: "Terminal",
};

interface ColumnCapabilities {
  readonly diff: boolean;
  readonly files: boolean;
  readonly preview: boolean;
  readonly terminal: boolean;
}

function capabilitiesOf(data: CompareColumnData): ColumnCapabilities {
  return {
    diff: data.diff.available,
    files: data.files.length > 0,
    preview: data.renderPreview !== null,
    terminal: data.terminalAvailable,
  };
}

function capabilitiesEqual(
  left: ColumnCapabilities | undefined,
  right: ColumnCapabilities,
): boolean {
  return (
    left !== undefined &&
    left.diff === right.diff &&
    left.files === right.files &&
    left.preview === right.preview &&
    left.terminal === right.terminal
  );
}

function EmptyCell({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex h-full min-h-24 flex-col items-center justify-center gap-2 px-3 text-center text-xs text-muted-foreground">
      {children}
    </div>
  );
}

function DiffCell({ data }: { readonly data: CompareColumnData }) {
  const { resolvedTheme } = useTheme();
  const parsed = useMemo(
    () => getRenderablePatch(data.diff.patch ?? undefined, `work-compare:${data.key}`),
    [data.diff.patch, data.key],
  );
  const items = useMemo<CodeViewDiffItem[]>(
    () =>
      parsed?.kind === "files"
        ? parsed.files.map((fileDiff, index) => ({
            id: `${data.key}:${fileDiff.name ?? fileDiff.prevName ?? index}`,
            type: "diff",
            fileDiff,
          }))
        : [],
    [parsed, data.key],
  );
  const options = useMemo(
    () => ({
      diffStyle: "unified" as const,
      lineDiffType: "none" as const,
      overflow: "scroll" as const,
      theme: resolveDiffThemeName(resolvedTheme),
      preferredHighlighter: PREFERRED_HIGHLIGHTER,
      themeType: resolvedTheme,
      stickyHeaders: true,
      enableGutterUtility: false,
      enableLineSelection: false,
    }),
    [resolvedTheme],
  );
  if (!data.diff.available) return <EmptyCell>No changes</EmptyCell>;
  if (data.diff.error !== null) return <EmptyCell>{data.diff.error}</EmptyCell>;
  if (data.diff.pending && parsed === null) return <EmptyCell>Loading diff…</EmptyCell>;
  if (parsed === null) return <EmptyCell>No changes</EmptyCell>;
  if (parsed.kind === "raw") {
    return (
      <pre className="whitespace-pre-wrap break-words px-3 py-2 font-mono text-[.7rem] leading-relaxed">
        {parsed.text}
      </pre>
    );
  }
  return (
    <StyledDiffCodeView
      className="h-full overflow-auto [scrollbar-gutter:stable]"
      items={items}
      options={options}
    />
  );
}

function ColumnBody({
  data,
  lens,
  onOpenLens,
}: {
  readonly data: CompareColumnData;
  readonly lens: CompareLens;
  readonly onOpenLens: (lens: CompareLens) => void;
}) {
  const { resolvedTheme } = useTheme();
  const navigate = useNavigate();
  const openInThread = (kind: "diff" | "files" | "terminal") => {
    if (kind !== "terminal") useRightPanelStore.getState().open(data.ref, kind);
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: data.ref.environmentId, threadId: data.ref.threadId },
    });
  };
  switch (lens) {
    case "answer":
      return data.answer === null ? (
        <EmptyCell>No report yet</EmptyCell>
      ) : (
        <div className="px-3 py-2">
          <ChatMarkdown text={data.answer} cwd={undefined} className="text-sm leading-relaxed" />
        </div>
      );
    case "diff":
      return <DiffCell data={data} />;
    case "files":
      return data.files.length === 0 ? (
        <EmptyCell>No files changed</EmptyCell>
      ) : (
        <div className="px-2 py-2">
          <ChangedFilesTree
            turnId={TurnId.make(`${data.ref.threadId}:compare`)}
            files={data.files}
            allDirectoriesExpanded
            resolvedTheme={resolvedTheme}
            onOpenTurnDiff={() => onOpenLens("diff")}
          />
        </div>
      );
    case "preview":
      return data.renderPreview === null ? (
        <EmptyCell>No preview running</EmptyCell>
      ) : (
        <div className="h-full min-h-0">{data.renderPreview()}</div>
      );
    case "terminal":
      return (
        <EmptyCell>
          {data.terminalAvailable
            ? "A terminal is running in this thread."
            : "No terminal running."}
          <Button size="compact" variant="outline" onClick={() => openInThread("terminal")}>
            Open thread
          </Button>
        </EmptyCell>
      );
  }
}

function CompareColumn({
  threadRef,
  lens,
  onCapabilities,
  onOpenLens,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly lens: CompareLens;
  readonly onCapabilities: (key: string, capabilities: ColumnCapabilities) => void;
  readonly onOpenLens: (lens: CompareLens) => void;
}) {
  const useColumn = useCompareColumnHook();
  const data = useColumn(threadRef);
  const navigate = useNavigate();
  const capabilities = capabilitiesOf(data);
  useEffect(() => {
    onCapabilities(data.key, capabilities);
  }, [
    data.key,
    capabilities.diff,
    capabilities.files,
    capabilities.preview,
    capabilities.terminal,
    onCapabilities,
    capabilities,
  ]);
  const visual = data.state === null ? null : workerStateVisual(data.state);
  const scrolls = lens === "answer" || lens === "files";
  return (
    <div className="flex min-h-0 min-w-0 flex-col" data-testid="compare-column">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border/60 px-2 text-xs">
        <span className="min-w-0 truncate font-medium">{data.label ?? data.title}</span>
        {visual ? (
          <span className={cn("shrink-0 font-mono text-[.65rem]", visual.textClass)}>
            {visual.label}
          </span>
        ) : null}
        <Button
          size="icon-micro"
          variant="ghost-muted"
          className="ml-auto"
          aria-label={`Open ${data.title}`}
          onClick={() =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId: data.ref.environmentId, threadId: data.ref.threadId },
            })
          }
        >
          <ExternalLink aria-hidden className="size-3" />
        </Button>
      </div>
      <div className={cn("min-h-0 flex-1", scrolls ? "overflow-auto" : "overflow-hidden")}>
        <ColumnBody data={data} lens={lens} onOpenLens={onOpenLens} />
      </div>
    </div>
  );
}

export function CompareSurface({
  refs,
  narrow,
}: {
  readonly refs: ReadonlyArray<ScopedThreadRef>;
  /** Below the inline breakpoint columns become tabs; nothing scrolls sideways. */
  readonly narrow: boolean;
}) {
  const lens = useWorkPanelStore((store) => store.lens);
  const setLens = useWorkPanelStore((store) => store.setLens);
  const closeCompare = useWorkPanelStore((store) => store.closeCompare);
  const clearSelection = useWorkPanelStore((store) => store.clearSelection);
  const [capabilitiesByKey, setCapabilitiesByKey] = useState<
    Readonly<Record<string, ColumnCapabilities>>
  >({});
  const [visibleColumn, setVisibleColumn] = useState(0);
  const onCapabilities = useCallback((key: string, capabilities: ColumnCapabilities) => {
    setCapabilitiesByKey((current) =>
      capabilitiesEqual(current[key], capabilities) ? current : { ...current, [key]: capabilities },
    );
  }, []);

  const known = Object.values(capabilitiesByKey);
  const lenses = LENS_ORDER.filter((entry) =>
    entry === "answer" ? true : known.some((capabilities) => capabilities[entry]),
  );
  const allHaveDiff =
    known.length === refs.length &&
    known.length > 0 &&
    known.every((capabilities) => capabilities.diff);
  const activeLens: CompareLens =
    lens !== null && lenses.includes(lens) ? lens : allHaveDiff ? "diff" : "answer";
  const column = Math.min(visibleColumn, Math.max(0, refs.length - 1));

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="work-compare">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-2">
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label="Back to Work"
          onClick={closeCompare}
        >
          <ArrowLeft />
        </Button>
        <span className="text-xs font-medium">Compare {refs.length}</span>
        <ToggleGroup
          variant="segmented"
          className="ml-1"
          value={[activeLens]}
          onValueChange={(value) => {
            const next = value[0];
            if (next !== undefined && lenses.includes(next as CompareLens)) {
              setLens(next as CompareLens);
            }
          }}
        >
          {lenses.map((entry) => (
            <Toggle key={entry} value={entry} className="h-6 px-2 text-xs">
              {LENS_LABELS[entry]}
            </Toggle>
          ))}
        </ToggleGroup>
        <Button
          size="icon-xs"
          variant="ghost-muted"
          className="ml-auto"
          aria-label="Clear selection"
          onClick={clearSelection}
        >
          <X />
        </Button>
      </div>
      {narrow ? (
        <div className="flex h-8 shrink-0 items-center border-b border-border/60 px-2">
          <ToggleGroup
            variant="segmented"
            value={[String(column)]}
            onValueChange={(value) => {
              const next = value[0];
              if (next !== undefined) setVisibleColumn(Number(next));
            }}
          >
            {refs.map((ref, index) => (
              <Toggle key={ref.threadId} value={String(index)} className="h-6 px-2 text-xs">
                {index + 1}
              </Toggle>
            ))}
          </ToggleGroup>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-x-auto">
        <div
          className={cn("grid h-full min-h-0", !narrow && "divide-x divide-border/60")}
          style={{
            gridTemplateColumns: narrow
              ? "minmax(0,1fr)"
              : `repeat(${refs.length}, minmax(18rem, 1fr))`,
          }}
        >
          {refs.map((ref, index) =>
            narrow && index !== column ? null : (
              <CompareColumn
                key={`${ref.environmentId}:${ref.threadId}`}
                threadRef={ref}
                lens={activeLens}
                onCapabilities={onCapabilities}
                onOpenLens={setLens}
              />
            ),
          )}
        </div>
      </div>
    </div>
  );
}
