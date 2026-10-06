import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { CommandId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  CircleAlertIcon,
  CloudUploadIcon,
  PencilIcon,
  RotateCwIcon,
  Trash2Icon,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import {
  durableCommandOutbox,
  restoredComposerContent,
  useDurableCommandOutbox,
  type DurableComposerEntry,
  type RestoredComposerContent,
} from "../../durableCommandOutbox";
import { readThreadShell } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { cn, randomUUID } from "~/lib/utils";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { presentDurableOutboxEntries, retryCountdownText } from "./durableOutboxPresentation";

/** Delivers saved messages for the whole session and reports rejections wherever the user is. */
export function DurableOutboxDelivery() {
  const navigate = useNavigate();
  const onRejected = useCallback(
    (entry: DurableComposerEntry) => {
      const threadRef = scopeThreadRef(entry.command.environmentId, entry.command.threadId);
      const open = () => {
        const draftId =
          readThreadShell(threadRef) === null
            ? useComposerDraftStore.getState().getDraftIdByRef(threadRef)
            : null;
        void (draftId
          ? navigate({ to: "/draft/$draftId", params: { draftId } })
          : navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(threadRef),
            }));
      };
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "A saved message was not delivered",
          ...(entry.state._tag === "Rejected" ? { description: entry.state.failure.message } : {}),
          actionProps: { children: "Open", onClick: open },
        }),
      );
    },
    [navigate],
  );
  useDurableCommandOutbox(onRejected);
  return null;
}

interface DurableOutboxStripProps {
  readonly entries: ReadonlyArray<DurableComposerEntry>;
  readonly connected: boolean;
  /** Puts a message taken back from the outbox into the composer. */
  readonly onRestore: (content: RestoredComposerContent) => void;
  readonly className?: string;
}

export const DurableOutboxStrip = memo(function DurableOutboxStrip({
  entries,
  connected,
  onRestore,
  className,
}: DurableOutboxStripProps) {
  const views = useMemo(
    () => presentDurableOutboxEntries(entries, connected),
    [connected, entries],
  );
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const countingDown = views.some((view) => view.retryAt !== null);

  useEffect(() => {
    if (!countingDown) return;
    const interval = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [countingDown]);

  if (views.length === 0) return null;

  const run = async (id: number, action: () => Promise<void>) => {
    setBusyId(id);
    setActionError(null);
    try {
      await action();
    } catch (cause) {
      setActionError(
        cause instanceof Error ? cause.message : "The saved message could not change.",
      );
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div
      data-durable-outbox-strip="true"
      aria-label={`Messages waiting to send (${views.length})`}
      className={cn(
        "mx-auto mb-2 max-h-48 max-w-3xl space-y-1 overflow-y-auto rounded-xl border border-info/25 bg-info/6 px-3 py-2 text-xs shadow-xs",
        className,
      )}
    >
      {views.map((view) => {
        const { entry } = view;
        const busy = busyId === entry.id;
        const countdown = retryCountdownText(view.retryAt, nowMs);
        return (
          <div
            key={entry.id}
            data-outbox-state={entry.state._tag}
            className="flex min-w-0 items-center gap-2.5"
          >
            {view.rejected ? (
              <CircleAlertIcon className="size-4 shrink-0 text-destructive" aria-hidden="true" />
            ) : (
              <CloudUploadIcon className="size-4 shrink-0 text-info" aria-hidden="true" />
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-foreground">{view.preview}</div>
              <div className={view.rejected ? "text-destructive" : "text-muted-foreground"}>
                {view.status}
                {countdown === null ? null : ` ${countdown}.`}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {view.retryLabel === null ? null : (
                <Button
                  type="button"
                  size="xs"
                  variant={view.rejected ? "outline" : "ghost"}
                  disabled={busy}
                  onClick={() =>
                    void run(entry.id, () =>
                      durableCommandOutbox().retry(entry.id, CommandId.make(randomUUID())),
                    )
                  }
                >
                  <RotateCwIcon className="size-3" aria-hidden="true" />
                  {view.retryLabel}
                </Button>
              )}
              {view.canTakeBack ? (
                <>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void run(entry.id, async () => {
                        const removed = await durableCommandOutbox().discard(entry.id);
                        if (removed) onRestore(restoredComposerContent(removed));
                      })
                    }
                  >
                    <PencilIcon className="size-3" aria-hidden="true" />
                    Edit
                  </Button>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Discard saved message"
                    disabled={busy}
                    onClick={() =>
                      void run(entry.id, async () => {
                        await durableCommandOutbox().discard(entry.id);
                      })
                    }
                  >
                    <Trash2Icon className="size-3.5" aria-hidden="true" />
                  </Button>
                </>
              ) : null}
            </div>
          </div>
        );
      })}
      {actionError ? (
        <p className="text-destructive" role="alert">
          {actionError}
        </p>
      ) : null}
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {views.map((view) => `${view.preview}: ${view.status}`).join(" ")}
      </span>
    </div>
  );
});
