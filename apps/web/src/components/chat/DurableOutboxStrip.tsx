import { CheckCircle2Icon, RotateCcwIcon, Trash2Icon, WifiOffIcon } from "lucide-react";
import type {
  DurableClientCommand,
  DurableCommandOutboxEntry,
} from "@t3tools/client-runtime/operations/command-outbox";
import { memo, useMemo } from "react";

import { newCommandId } from "../../lib/utils";
import { cn } from "../../lib/utils";
import {
  localRetryCountdownText,
  presentDurableOutboxEntry,
  type DurableOutboxEntryView,
} from "./durableOutboxPresentation";
import { Button } from "../ui/button";

export const DurableOutboxStrip = memo(function DurableOutboxStrip({
  entries,
  onCancel,
  onReplace,
  onDiscard,
}: {
  readonly entries: ReadonlyArray<DurableCommandOutboxEntry>;
  readonly onCancel: (commandId: DurableClientCommand["commandId"]) => void;
  readonly onReplace: (
    commandId: DurableClientCommand["commandId"],
    replacement: DurableClientCommand,
    state: "Pending" | "Rejected",
  ) => void;
  readonly onDiscard: (commandId: DurableClientCommand["commandId"]) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <div
      className="mx-auto mb-2 w-full max-w-3xl space-y-1.5 rounded-xl border border-border bg-muted/35 p-2 text-xs"
      aria-label={`Saved messages (${entries.length})`}
      data-durable-outbox-strip="true"
    >
      <div className="flex items-center gap-1.5 px-1 text-[11px] font-medium text-muted-foreground">
        <WifiOffIcon className="size-3.5" />
        <span>Saved on this device</span>
        <span className="ml-auto tabular-nums">{entries.length}</span>
      </div>
      {entries.map((entry) => (
        <DurableOutboxRow
          key={entry.plan.command.commandId}
          entry={entry}
          onCancel={onCancel}
          onReplace={onReplace}
          onDiscard={onDiscard}
        />
      ))}
    </div>
  );
});

function DurableOutboxRow({
  entry,
  onCancel,
  onReplace,
  onDiscard,
}: {
  readonly entry: DurableCommandOutboxEntry;
  readonly onCancel: (commandId: DurableClientCommand["commandId"]) => void;
  readonly onReplace: (
    commandId: DurableClientCommand["commandId"],
    replacement: DurableClientCommand,
    state: "Pending" | "Rejected",
  ) => void;
  readonly onDiscard: (commandId: DurableClientCommand["commandId"]) => void;
}) {
  const view = presentDurableOutboxEntry(entry);
  const retryLabel = useMemo(
    () => localRetryCountdownText(view.retryAt, Date.now()),
    [view.retryAt],
  );
  const command = entry.plan.command;
  const replacement = {
    ...command,
    commandId: newCommandId(),
    createdAt: new Date().toISOString(),
  } satisfies DurableClientCommand;
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-background/60 px-2 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-foreground">{command.message.text || "Image"}</div>
        <div className="truncate text-[11px] text-muted-foreground">{view.detail}{retryLabel ? ` ${retryLabel}` : ""}</div>
      </div>
      <OutboxActions
        view={view}
        command={command}
        replacement={replacement}
        onCancel={onCancel}
        onReplace={onReplace}
        onDiscard={onDiscard}
      />
    </div>
  );
}

function OutboxActions({
  view,
  command,
  replacement,
  onCancel,
  onReplace,
  onDiscard,
}: {
  readonly view: DurableOutboxEntryView;
  readonly command: DurableClientCommand;
  readonly replacement: DurableClientCommand;
  readonly onCancel: (commandId: DurableClientCommand["commandId"]) => void;
  readonly onReplace: (
    commandId: DurableClientCommand["commandId"],
    replacement: DurableClientCommand,
    state: "Pending" | "Rejected",
  ) => void;
  readonly onDiscard: (commandId: DurableClientCommand["commandId"]) => void;
}) {
  if (view.canCancel) {
    return <Button size="icon-xs" variant="ghost" aria-label="Cancel saved message" onClick={() => onCancel(command.commandId)}><Trash2Icon className="size-3.5" /></Button>;
  }
  if (view.canRetry) {
    return <div className="flex items-center gap-1"><Button size="xs" variant="outline" onClick={() => onReplace(command.commandId, replacement, "Rejected")}><RotateCcwIcon className="size-3" />Retry</Button><Button size="icon-xs" variant="ghost" aria-label="Discard rejected message" onClick={() => onDiscard(command.commandId)}><Trash2Icon className="size-3.5" /></Button></div>;
  }
  return <CheckCircle2Icon className={cn("size-4 shrink-0", view.attempt === null ? "text-muted-foreground/60" : "text-primary")} aria-hidden />;
}
