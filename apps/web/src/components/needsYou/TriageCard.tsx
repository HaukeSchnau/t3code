import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  needsYouAnswers,
  needsYouAnswerSent,
  needsYouCard,
  needsYouPageFrame,
  TRIAGE_SNOOZE_MS,
} from "@t3tools/client-runtime/state/needs-you-triage";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { threadNeedLabel } from "@t3tools/client-runtime/state/thread-inbox";
import { derivePendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import { canSnooze } from "@t3tools/client-runtime/state/thread-settled";
import {
  AuthOrchestrationOperateScope,
  type OrchestrationMessageContext,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { shouldPreserveAssistantLineBreaks } from "@t3tools/shared/assistantInsights";
import { projectScriptCwd } from "@t3tools/shared/projectScripts";
import { useNavigate } from "@tanstack/react-router";
import { AlarmClockIcon, ArrowUpRightIcon, MessageCircleOffIcon, SendIcon } from "lucide-react";
import { useEffect, useEffectEvent } from "react";
import { T, useGT, useMessages } from "gt-react";

import { enqueueComposerSend } from "~/durableCommandOutbox";
import { useNowMinute } from "~/hooks/useNowMinute";
import { useThreadActions } from "~/hooks/useThreadActions";
import { newMessageId } from "~/lib/utils";
import { useProject, useQuietThreadProjection, useThreadVisibleTurnItems } from "~/state/entities";
import { useConnectedEnvironmentIds } from "~/state/environments";
import { htmlRenderEnvironment } from "~/state/htmlRender";
import { useEnvironmentQuery } from "~/state/query";
import { readEnvironmentScope } from "~/state/session";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { formatRelativeTime } from "~/timestampFormat";
import { buildThreadRouteParams } from "~/threadRoutes";

import ChatMarkdown from "../ChatMarkdown";
import { HtmlRenderFrame } from "../chat/HtmlRenderFrame";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Skeleton } from "../ui/skeleton";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { isTriageEscape, triageKeyAction, triageKeyTarget, triageReplySends } from "./triageKeys";

/** One thread that needs you: what it asks, what the agent said last, and the ways to answer. */
export function TriageCard(props: {
  readonly thread: EnvironmentThreadShell;
  readonly threadRef: ScopedThreadRef;
  readonly draft: string;
  /** The thread's reply or answer is on its way, also one from before triage or the app closed. */
  readonly sending: boolean;
  readonly onDraftChange: (text: string) => void;
  /** Sends unless one is on its way; a send that went out with `text` clears that draft. */
  readonly send: (deliver: () => Promise<boolean>, text?: string) => Promise<boolean>;
  /** The same for the page's sends, refused while one is on its way. */
  readonly sendFromPage: (deliver: () => Promise<boolean>) => Promise<void>;
  readonly onStep: (delta: 1 | -1) => void;
}) {
  const { thread, threadRef, sending } = props;
  const gt = useGT();
  const m = useMessages();
  const navigate = useNavigate();
  const nowMinute = useNowMinute();
  const project = useProject(scopeProjectRef(thread.environmentId, thread.projectId));
  const rows = useThreadVisibleTurnItems(threadRef);
  const structure = useQuietThreadProjection(threadRef);
  const connected = useConnectedEnvironmentIds().includes(threadRef.environmentId);
  const { snoozeThread, dismissThreadAsks } = useThreadActions();
  const respondToUserInput = useOrchestrationCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });

  const { need, latest, page, question, waitingOn, replyMode, answersHere, hasOpenAsks } =
    needsYouCard({
      thread,
      rows,
      requests: structure === null ? null : derivePendingThreadRequests(structure.projection),
    });
  // A page further back than the loaded timeline comes from the thread's page index.
  const indexedPages = useEnvironmentQuery(
    page !== null && page.versions === null
      ? htmlRenderEnvironment.pages({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, renderId: page.renderId, filter: "all", limit: 1 },
        })
      : null,
  );
  const pageFrame =
    page === null ? null : needsYouPageFrame(page, indexedPages.data?.pages ?? null);
  const nowMs = Date.parse(`${nowMinute}:00.000Z`);
  const snoozable = canSnooze(thread, { now: `${nowMinute}:00.000Z` });
  const cwd =
    project === null
      ? undefined
      : projectScriptCwd({
          project: { cwd: project.workspaceRoot },
          worktreePath: thread.worktreePath,
        });

  const fail = (title: string, error: unknown) =>
    toastManager.add({
      type: "error",
      title,
      description: error instanceof Error ? error.message : undefined,
    });

  // A reply is a user message, which ends every open ask of the thread. It goes through the
  // outbox like the composer's offline sends, so one sent offline or cut off on the way arrives
  // once, and it is on its way until the outbox delivers or drops it.
  const queueMessage = async (text: string, context?: OrchestrationMessageContext) => {
    if (!readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)) {
      throw new Error("This connection cannot change threads or projects.");
    }
    const messageId = newMessageId();
    await enqueueComposerSend({
      environmentId: threadRef.environmentId,
      threadId: threadRef.threadId,
      messageId,
      // oxlint-disable-next-line react/purity -- runs in an event handler (oxc#27309)
      createdAt: new Date().toISOString(),
      text,
      context,
      attachments: [],
      modelSelection: thread.modelSelection,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      dispatchMode: "queue",
      createThread: null,
      prepareWorktree: null,
      prepareWorkspace: null,
      inheritThreadSettings: true,
    });
    return true;
  };

  const answer = async (reply: Parameters<typeof needsYouAnswers>[1]) => {
    const answers = question === null ? null : needsYouAnswers(question, reply);
    if (question === null || answers === null) return false;
    const result = await respondToUserInput({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, requestId: question.requestId, answers },
    });
    return needsYouAnswerSent(result, (error) => fail("Could not send the answer", error));
  };

  const submitReply = () => {
    const draft = props.draft;
    if (sending || draft.trim().length === 0 || replyMode === null) return;
    void props.send(
      () =>
        replyMode === "answer"
          ? answer({ text: draft })
          : queueMessage(draft.trim()).catch((error: unknown) => {
              fail("Could not send the reply", error);
              return false;
            }),
      draft,
    );
  };

  const pickOption = (option: string) => {
    if (!sending) void props.send(() => answer({ option }));
  };

  const openThread = () =>
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(threadRef) });
  const snooze = () => {
    if (!snoozable) return;
    void snoozeThread(threadRef, new Date(Date.now() + TRIAGE_SNOOZE_MS).toISOString());
  };
  const dismiss = () => {
    if (hasOpenAsks) void dismissThreadAsks(threadRef);
  };

  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    const action = triageKeyAction(event, triageKeyTarget(event.target));
    if (action === null) return;
    event.preventDefault();
    if (action === "next") props.onStep(1);
    else if (action === "previous") props.onStep(-1);
    else if (action === "open") openThread();
    else if (action === "snooze") snooze();
    else dismiss();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the deck's letter keys listen on the window while the card is shown
  useEffect(() => {
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (need === null) return null;
  const kindLabel = threadNeedLabel({ ...need, text: null });
  const waited = need.since === null ? null : formatRelativeTime(need.since, nowMs, m);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="triage-card">
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-gutter-both">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-5 py-6">
          <div className="flex min-w-0 flex-col gap-1">
            <p className="truncate text-muted-foreground text-xs">
              {project?.isScratch ? gt("No project") : (project?.title ?? gt("Project"))}
              {" · "}
              {kindLabel}
              {waited === null
                ? null
                : waited.suffix === null
                  ? ` · ${gt("just now")}`
                  : ` · ${gt("waiting {duration}", { duration: waited.value })}`}
            </p>
            <h2 className="font-semibold text-lg leading-snug">{thread.title}</h2>
          </div>
          {need.text !== null ? (
            <p className="rounded-lg border bg-card px-4 py-3 font-medium text-base">{need.text}</p>
          ) : null}
          {need.kind === "page" ? (
            pageFrame !== null ? (
              <HtmlRenderFrame
                // The page's render id: the thread's next page starts at its newest version.
                key={pageFrame.render.attachmentId}
                environmentId={threadRef.environmentId}
                htmlRender={pageFrame.render}
                versions={pageFrame.versions}
                threadRef={threadRef}
                onSendMessage={(text, context) =>
                  props.sendFromPage(() => queueMessage(text, context))
                }
              />
            ) : structure !== null && (indexedPages.isSuccess || indexedPages.error !== null) ? (
              <p className="text-muted-foreground text-sm">
                <T>The page is further back in the thread. Open the thread to see it.</T>
              </p>
            ) : (
              <Skeleton className="h-40 w-full" />
            )
          ) : null}
          {question !== null ? (
            <section className="flex flex-col gap-2" aria-label={gt("Question")}>
              <p className="font-medium text-sm">{question.question}</p>
              <div className="flex flex-col gap-1.5">
                {question.options.map((option) => (
                  <Button
                    key={option.value ?? option.label}
                    className="w-full justify-start"
                    size="multiline"
                    variant="secondary"
                    disabled={sending}
                    onClick={() => pickOption(option.value ?? option.label)}
                  >
                    <span className="flex min-w-0 flex-col items-start text-start">
                      <span className="font-medium">{option.label}</span>
                      <span className="text-muted-foreground text-xs">{option.description}</span>
                    </span>
                  </Button>
                ))}
              </div>
            </section>
          ) : null}
          {waitingOn.length > 0 ? (
            <ul className="flex flex-col gap-1.5 rounded-lg border bg-card px-4 py-3 font-medium text-sm">
              {waitingOn.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          ) : null}
          <section className="flex min-w-0 flex-col gap-2" aria-label={gt("Last message")}>
            <h3 className="text-muted-foreground text-xs">
              <T>Last message</T>
            </h3>
            {latest !== null ? (
              <div className="min-w-0 rounded-lg border px-4 py-3">
                <ChatMarkdown
                  text={latest.text}
                  cwd={cwd}
                  threadRef={threadRef}
                  isStreaming={latest.streaming}
                  lineBreaks={shouldPreserveAssistantLineBreaks(latest.text)}
                />
              </div>
            ) : structure !== null ? (
              <p className="text-muted-foreground text-sm">
                <T>The agent has not written yet.</T>
              </p>
            ) : connected ? (
              <Skeleton className="h-24 w-full" />
            ) : (
              <p className="text-muted-foreground text-sm">
                <T>Its environment is not connected.</T>
              </p>
            )}
          </section>
        </div>
      </div>
      <footer className="shrink-0 border-t px-5 py-3">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
          {replyMode !== null ? (
            <div className="flex items-end gap-2">
              <Textarea
                aria-label={
                  replyMode === "answer" ? gt("Your answer") : gt("Reply", { $context: "noun" })
                }
                className="flex-1"
                placeholder={
                  replyMode === "answer" ? gt("Or type your answer") : gt("Reply to the agent")
                }
                rows={2}
                value={props.draft}
                onChange={(event) => props.onDraftChange(event.target.value)}
                onKeyDown={(event) => {
                  // Esc leaves the box; the next Esc closes triage.
                  if (isTriageEscape(event.nativeEvent)) event.currentTarget.blur();
                  if (!triageReplySends(event.nativeEvent)) return;
                  event.preventDefault();
                  submitReply();
                }}
              />
              <Button
                aria-label={gt("Send", { $context: "verb" })}
                size="icon"
                disabled={sending || props.draft.trim().length === 0}
                onClick={submitReply}
              >
                <SendIcon />
              </Button>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant={answersHere ? "ghost" : "default"} onClick={openThread}>
              <ArrowUpRightIcon />
              {answersHere ? gt("Open thread") : gt("Open thread to answer")}
              <Kbd>O</Kbd>
            </Button>
            <Button size="sm" variant="ghost" disabled={!snoozable} onClick={snooze}>
              <AlarmClockIcon />
              <T>Snooze 1 h</T>
              <Kbd>S</Kbd>
            </Button>
            {hasOpenAsks ? (
              <Button size="sm" variant="ghost" onClick={dismiss}>
                <MessageCircleOffIcon />
                <T>No reply needed</T>
                <Kbd>X</Kbd>
              </Button>
            ) : null}
          </div>
        </div>
      </footer>
    </div>
  );
}
