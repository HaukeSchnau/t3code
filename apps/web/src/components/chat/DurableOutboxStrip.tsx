import type {
  DurableClientCommand,
  DurableCommandOutboxEntry,
} from "@t3tools/client-runtime/operations/command-outbox";
import type { CommandId } from "@t3tools/contracts";
import { LoaderCircleIcon, PencilIcon, RotateCwIcon, Trash2Icon } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";

import { cn, newCommandId } from "~/lib/utils";
import { Button } from "../ui/button";
import { localRetryCountdownText, presentDurableOutboxEntry } from "./durableOutboxPresentation";

interface DurableOutboxStripProps {
  readonly entries: ReadonlyArray<DurableCommandOutboxEntry>;
  readonly className?: string;
  readonly onCancel: (commandId: CommandId) => Promise<void>;
  readonly onReplace: (
    commandId: CommandId,
    replacement: DurableClientCommand,
    state: "Pending" | "Rejected",
  ) => Promise<void>;
  readonly onDiscard: (commandId: CommandId) => Promise<void>;
}

export const DurableOutboxStrip = memo(function DurableOutboxStrip({
  entries,
  className,
  onCancel,
  onReplace,
  onDiscard,
}: DurableOutboxStripProps) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [editingCommandId, setEditingCommandId] = useState<CommandId | null>(null);
  const [editText, setEditText] = useState("");
  const [busyCommandId, setBusyCommandId] = useState<CommandId | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const views = useMemo(() => entries.map(presentDurableOutboxEntry), [entries]);
  const hasRetryCountdown = views.some((view) => view.retryAt !== null);

  useEffect(() => {
    if (!hasRetryCountdown) return;
    const interval = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [hasRetryCountdown]);

  if (views.length === 0) return null;

  const run = async (commandId: CommandId, task: () => Promise<void>) => {
    setBusyCommandId(commandId);
    setActionError(null);
    try {
      await task();
      setEditingCommandId(null);
    } catch (cause) {
      setActionError(
        cause instanceof Error ? cause.message : "The saved message could not be updated.",
      );
    } finally {
      setBusyCommandId(null);
    }
  };

  return (
    <div
      className={cn(
        "mx-auto mb-2 max-h-52 w-full max-w-3xl space-y-1 overflow-y-auto rounded-xl border border-info/25 bg-info/6 p-1.5 shadow-xs",
        className,
      )}
      aria-label={`Messages saved on this device (${views.length})`}
      data-durable-outbox-strip="true"
    >
      {views.map((view) => {
        const command = view.entry.plan.command;
        const commandId = command.commandId;
        const editing = editingCommandId === commandId;
        const busy = busyCommandId === commandId;
        const retryText = localRetryCountdownText(view.retryAt, nowMs);

        return (
          <div
            key={commandId}
            className="rounded-lg px-2 py-1.5 text-xs text-muted-foreground"
            data-outbox-command-id={commandId}
            data-outbox-state={view.entry.state._tag}
          >
            <div className="flex min-w-0 items-center gap-2">
              {view.entry.state._tag === "Delivering" ? (
                <LoaderCircleIcon
                  className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                <span className="size-2 shrink-0 rounded-full bg-info" aria-hidden="true" />
              )}
              <div className="min-w-0 flex-1">
                <div className="font-medium text-foreground">{view.title}</div>
                <div className="truncate">
                  {view.detail}
                  {view.attempt !== null ? ` Attempt ${view.attempt}.` : ""}
                  {retryText !== null ? ` ${retryText}.` : ""}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {view.canEdit ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setEditingCommandId(commandId);
                      setEditText(command.message.text);
                    }}
                  >
                    <PencilIcon className="size-3" aria-hidden="true" />
                    Edit
                  </Button>
                ) : null}
                {view.canCancel ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void run(commandId, () => onCancel(commandId))}
                  >
                    Cancel
                  </Button>
                ) : null}
                {view.canRetry ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void run(commandId, () =>
                        onReplace(commandId, { ...command, commandId: newCommandId() }, "Rejected"),
                      )
                    }
                  >
                    <RotateCwIcon
                      className={cn("size-3", busy && "animate-spin motion-reduce:animate-none")}
                      aria-hidden="true"
                    />
                    Retry
                  </Button>
                ) : null}
                {view.canDiscard ? (
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Discard rejected message"
                    disabled={busy}
                    onClick={() => void run(commandId, () => onDiscard(commandId))}
                  >
                    <Trash2Icon className="size-3.5" aria-hidden="true" />
                  </Button>
                ) : null}
              </div>
            </div>
            {editing ? (
              <form
                className="mt-2 flex gap-1.5"
                onSubmit={(event) => {
                  event.preventDefault();
                  const text = editText.trim();
                  if (!text) return;
                  const replacement: DurableClientCommand =
                    command.type === "thread.turn.start"
                      ? {
                          ...command,
                          commandId: newCommandId(),
                          message: { ...command.message, text },
                          titleSeed: text,
                        }
                      : {
                          ...command,
                          commandId: newCommandId(),
                          message: { ...command.message, text },
                          titleSeed: text,
                        };
                  void run(commandId, () => onReplace(commandId, replacement, "Pending"));
                }}
              >
                <label className="sr-only" htmlFor={`outbox-edit-${commandId}`}>
                  Edit saved message
                </label>
                <input
                  id={`outbox-edit-${commandId}`}
                  className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={editText}
                  autoFocus
                  disabled={busy}
                  onChange={(event) => setEditText(event.target.value)}
                />
                <Button type="submit" size="xs" disabled={busy || editText.trim().length === 0}>
                  Save
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setEditingCommandId(null)}
                >
                  Close
                </Button>
              </form>
            ) : null}
            <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
              {view.title}. {view.detail}
            </span>
          </div>
        );
      })}
      {actionError ? (
        <p className="px-2 py-1 text-destructive text-xs" role="alert">
          {actionError}
        </p>
      ) : null}
    </div>
  );
});
