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
import { memo, useEffect, useState } from "react";
import { msg, T, useGT, useMessages } from "gt-react";

import { useComposerDraftStore } from "../../composerDraftStore";
import {
  durableCommandOutbox,
  restoredComposerContent,
  useDurableCommandOutbox,
  type DurableComposerEntry,
  type RestoredComposerContent,
} from "../../durableCommandOutbox";
import { m } from "../../i18n/messages";
import { readThreadShell } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { cn, randomUUID } from "~/lib/utils";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ComposerBanner } from "./ComposerBanner";
import { NoticeText } from "./ComposerBannerStack";
import { presentDurableOutboxEntries, retryCountdownText } from "./durableOutboxPresentation";

/** Delivers saved messages for the whole session and reports rejections wherever the user is. */
export function DurableOutboxDelivery() {
  const navigate = useNavigate();
  const onRejected = (entry: DurableComposerEntry) => {
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
        title: m(msg("A saved message was not delivered")),
        ...(entry.state._tag === "Rejected" ? { description: entry.state.failure.message } : {}),
        actionProps: { children: m(msg("Open", { $context: "verb" })), onClick: open },
      }),
    );
  };
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
  const gt = useGT();
  const messages = useMessages();
  const views = presentDurableOutboxEntries(entries, connected, messages);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const countingDown = views.some((view) => view.retryAt !== null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The retry countdown ticks with the wall clock.
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
        cause instanceof Error ? cause.message : gt("The saved message could not change."),
      );
    }
    setBusyId(null);
  };

  return (
    <ComposerBanner.Surface
      detached
      data-durable-outbox-strip="true"
      aria-label={gt("Messages waiting to send ({count})", { count: views.length })}
      className={cn("mb-2", className)}
    >
      <ComposerBanner.Scroll>
        {views.map((view) => {
          const { entry } = view;
          const busy = busyId === entry.id;
          const countdown = retryCountdownText(view.retryAt, nowMs, messages);
          return (
            <ComposerBanner.Root
              key={entry.id}
              data-outbox-state={entry.state._tag}
              variant={view.rejected ? "error" : "info"}
            >
              <ComposerBanner.Row layout="wrap-actions">
                <ComposerBanner.Icon>
                  {view.rejected ? <CircleAlertIcon /> : <CloudUploadIcon />}
                </ComposerBanner.Icon>
                <ComposerBanner.Content className="items-baseline whitespace-nowrap">
                  <NoticeText
                    detailsLabel={gt("Show the saved message")}
                    className="min-w-0 truncate text-foreground"
                  >
                    {view.preview}
                  </NoticeText>
                  <NoticeText
                    detailsLabel={gt("Show why it is waiting")}
                    className={cn(
                      "w-0 min-w-0 grow truncate @max-[400px]:sr-only",
                      view.rejected ? "text-destructive-foreground" : "text-muted-foreground",
                    )}
                  >
                    {view.status}
                    {countdown === null ? null : ` ${countdown}.`}
                  </NoticeText>
                </ComposerBanner.Content>
                <ComposerBanner.Actions>
                  {view.retryLabel === null ? null : (
                    <Button
                      type="button"
                      size="xs"
                      variant={view.rejected ? "secondary" : "ghost"}
                      disabled={busy}
                      onClick={() =>
                        void run(entry.id, () =>
                          durableCommandOutbox().retry(entry.id, CommandId.make(randomUUID())),
                        )
                      }
                    >
                      <RotateCwIcon aria-hidden="true" />
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
                        <PencilIcon aria-hidden="true" />
                        <T context="verb">Edit</T>
                      </Button>
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        aria-label={gt("Discard saved message")}
                        disabled={busy}
                        onClick={() =>
                          void run(entry.id, async () => {
                            await durableCommandOutbox().discard(entry.id);
                          })
                        }
                      >
                        <Trash2Icon aria-hidden="true" />
                      </Button>
                    </>
                  ) : null}
                </ComposerBanner.Actions>
              </ComposerBanner.Row>
            </ComposerBanner.Root>
          );
        })}
      </ComposerBanner.Scroll>
      {actionError ? (
        <p className="px-3.5 pb-2.5 text-meta text-destructive-foreground" role="alert">
          {actionError}
        </p>
      ) : null}
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {views.map((view) => `${view.preview}: ${view.status}`).join(" ")}
      </span>
    </ComposerBanner.Surface>
  );
});
