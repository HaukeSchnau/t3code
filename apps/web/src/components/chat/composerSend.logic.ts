import type { ComposerDispatchMode } from "@t3tools/client-runtime/state/composer-dispatch";
import type { ThreadPendingApproval } from "@t3tools/client-runtime/state/thread-requests";
import type { RuntimeRequestId } from "@t3tools/contracts";
import { msg } from "gt-react";
import { m, type MessageResolver } from "../../i18n/messages";
import { isTriagePrompt } from "@t3tools/shared/triagePrompt";
import type { ComposerThreadDraftState } from "../../composerDraftStore";

/** Compare immutable user content without copying image bytes or upload metadata. */
export function composerDraftContentChanged(
  before: ComposerThreadDraftState | null,
  after: ComposerThreadDraftState | null,
): boolean {
  if (before === after) return false;
  if (!before || !after) return true;
  const sameIds = (left: ReadonlyArray<{ id: string }>, right: ReadonlyArray<{ id: string }>) =>
    left.length === right.length && left.every((item, index) => item.id === right[index]?.id);
  return (
    before.prompt !== after.prompt ||
    !sameIds(before.images, after.images) ||
    !sameIds(before.files, after.files) ||
    before.terminalContexts !== after.terminalContexts ||
    before.previewAnnotations !== after.previewAnnotations ||
    before.reviewComments !== after.reviewComments ||
    before.threadContexts !== after.threadContexts ||
    before.environmentContexts !== after.environmentContexts ||
    before.replyTo !== after.replyTo
  );
}

/**
 * Why a multiple-model send cannot start: the server predates worktree bootstrap, or the
 * draft is not a new thread on a Git branch with at least one model.
 */
export function multipleModelSendBlock(input: {
  readonly selectionCount: number;
  readonly serverSupportsWorktreeBootstrap: boolean;
  readonly isLocalDraftThread: boolean;
  readonly isGitRepo: boolean;
  readonly branch: string | null;
}): "server-outdated" | "needs-new-git-thread" | null {
  if (!input.serverSupportsWorktreeBootstrap) return "server-outdated";
  if (
    !input.isLocalDraftThread ||
    !input.isGitRepo ||
    !input.branch ||
    input.selectionCount === 0
  ) {
    return "needs-new-git-thread";
  }
  return null;
}

/** Why a message sent over pending approvals did not go out, or null to stop quietly. */
export function approvalRedirectNotice(
  input: {
    readonly draftChanged: boolean;
    readonly declined: boolean;
    readonly approvalResponding: boolean;
    readonly approvalArrived: boolean;
  },
  resolve: MessageResolver = m,
): string | null {
  if (input.draftChanged) {
    return input.declined
      ? resolve(msg("Approval declined. Your message changed, so it wasn't sent."))
      : resolve(msg("Your message changed, so it wasn't sent."));
  }
  if (input.approvalResponding) {
    return resolve(msg("An approval is already being answered, so your message wasn't sent."));
  }
  if (input.declined && input.approvalArrived) {
    return resolve(msg("Another approval arrived, so your message wasn't sent."));
  }
  return null;
}

/** Whether Auto may place a new thread: a triage prompt links this machine's playbook, a
 * repository choice names its paths, and a checked-out pull request is its checkout. */
export function sendPlacesThread(input: {
  readonly autoPlacement: boolean;
  readonly worktreeRepositories: ReadonlyArray<{ readonly path: string }> | undefined;
  readonly prompt: string;
  readonly checksOutPullRequest: boolean;
}): boolean {
  return (
    input.autoPlacement &&
    input.worktreeRepositories === undefined &&
    !isTriagePrompt(input.prompt) &&
    !input.checksOutPullRequest
  );
}

export function approvalsForComposerRedirect(input: {
  readonly approvals: ReadonlyArray<ThreadPendingApproval>;
  readonly shownApprovalIds: ReadonlyArray<RuntimeRequestId>;
  readonly dispatchMode: ComposerDispatchMode;
  readonly sameThread: boolean;
}) {
  if (!input.sameThread || input.dispatchMode === "queue") return [];
  return input.approvals.filter((approval) => input.shownApprovalIds.includes(approval.requestId));
}

export function composerDraftChangedSinceSend(input: {
  readonly pendingAttachments: boolean;
  readonly prompt: string;
  readonly sentPrompts: ReadonlyArray<string>;
  readonly attachmentIds: ReadonlyArray<string>;
  readonly sentAttachmentIds: ReadonlyArray<string>;
  readonly annotationImageId: string | undefined;
}): boolean {
  if (input.pendingAttachments) return true;
  const sameIds = (ids: ReadonlyArray<string>) =>
    ids.length === input.attachmentIds.length &&
    ids.every((id, index) => id === input.attachmentIds[index]);
  const attachmentsUnchanged =
    sameIds(input.sentAttachmentIds) ||
    (input.annotationImageId !== undefined &&
      sameIds(input.sentAttachmentIds.filter((id) => id !== input.annotationImageId)));
  return !input.sentPrompts.includes(input.prompt) || !attachmentsUnchanged;
}
