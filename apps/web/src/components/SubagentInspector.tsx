import { BotIcon, ClockIcon, XIcon } from "lucide-react";

import { type SubagentTimelineEntry } from "../subagents";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { formatTimestamp } from "../timestampFormat";
import { cn } from "~/lib/utils";
import { Button } from "./ui/button";
import ChatMarkdown from "./ChatMarkdown";

export function SubagentInspector(props: {
  subagent: SubagentTimelineEntry | null;
  markdownCwd: string | undefined;
  timestampFormat: TimestampFormat;
  onClose: () => void;
}) {
  const subagent = props.subagent;

  return (
    <aside className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 items-start justify-between gap-3 border-border border-b px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/70 bg-card text-muted-foreground">
              <BotIcon className="size-4" />
            </span>
            <div className="min-w-0">
              <h2 className="truncate font-medium text-sm text-foreground">
                {subagent?.label ?? "Subagent"}
              </h2>
              <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                {subagent ? <StatusPill status={subagent.status} /> : null}
                {subagent?.updatedAt ? (
                  <>
                    <ClockIcon className="size-3" />
                    <span className="truncate">
                      {formatTimestamp(subagent.updatedAt, props.timestampFormat)}
                    </span>
                  </>
                ) : null}
              </div>
            </div>
          </div>
        </div>
        <Button type="button" size="icon-sm" variant="ghost" title="Close" onClick={props.onClose}>
          <XIcon className="size-4" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {subagent ? (
          <div className="space-y-5">
            <MetadataGrid subagent={subagent} timestampFormat={props.timestampFormat} />
            {subagent.prompt ? (
              <section className="space-y-2">
                <h3 className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground/65">
                  Prompt
                </h3>
                <div className="rounded-md border border-border/70 bg-card/35 p-3 text-xs leading-5 text-foreground/90 whitespace-pre-wrap wrap-break-word">
                  {subagent.prompt}
                </div>
              </section>
            ) : null}
            <section className="space-y-2">
              <h3 className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground/65">
                Transcript
              </h3>
              {subagent.transcript.trim().length > 0 ? (
                <div className="rounded-md border border-border/70 bg-card/30 p-3">
                  <ChatMarkdown
                    text={subagent.transcript}
                    cwd={props.markdownCwd}
                    isStreaming={subagent.status === "running" || subagent.status === "waiting"}
                  />
                </div>
              ) : (
                <div className="rounded-md border border-border/70 bg-card/30 px-3 py-8 text-center text-muted-foreground/55 text-sm">
                  No assistant text yet.
                </div>
              )}
            </section>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground/55 text-sm">
            No subagent selected.
          </div>
        )}
      </div>
    </aside>
  );
}

function MetadataGrid(props: {
  subagent: SubagentTimelineEntry;
  timestampFormat: TimestampFormat;
}) {
  const rows: Array<{ label: string; value: string }> = [
    { label: "Thread", value: props.subagent.providerThreadId },
    { label: "Started", value: formatTimestamp(props.subagent.startedAt, props.timestampFormat) },
    { label: "Updated", value: formatTimestamp(props.subagent.updatedAt, props.timestampFormat) },
  ];
  if (props.subagent.model) {
    rows.push({ label: "Model", value: props.subagent.model });
  }
  if (props.subagent.reasoningEffort) {
    rows.push({ label: "Reasoning", value: props.subagent.reasoningEffort });
  }
  if (props.subagent.lastActivity) {
    rows.push({ label: "Activity", value: props.subagent.lastActivity });
  }

  return (
    <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 rounded-md border border-border/70 bg-card/25 p-3 text-xs">
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <dt className="text-muted-foreground/65">{row.label}</dt>
          <dd className="min-w-0 truncate text-foreground/85" title={row.value}>
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function StatusPill(props: { status: SubagentTimelineEntry["status"] }) {
  return (
    <span
      className={cn(
        "rounded border px-1.5 py-0.5 text-[9px] uppercase tracking-[0.12em]",
        props.status === "failed"
          ? "border-rose-500/30 text-rose-500"
          : props.status === "completed"
            ? "border-emerald-500/25 text-emerald-600 dark:text-emerald-400"
            : props.status === "waiting"
              ? "border-amber-500/25 text-amber-600 dark:text-amber-400"
              : "border-border/70 text-muted-foreground",
      )}
    >
      {props.status === "unknown" ? "Subagent" : props.status}
    </span>
  );
}
