import { type ApprovalRequestId } from "@t3tools/contracts";
import { type PendingUserInputDraftAnswer } from "../../pendingUserInput";
import { type PendingApproval, type PendingUserInput } from "../../session-logic";
import { ChatComposer, type ChatComposerProps } from "./ChatComposer";

const EMPTY_PENDING_APPROVALS: PendingApproval[] = [];
const EMPTY_PENDING_USER_INPUTS: PendingUserInput[] = [];
const EMPTY_APPROVAL_REQUEST_IDS: ApprovalRequestId[] = [];
const EMPTY_PENDING_USER_INPUT_ANSWERS: Record<string, PendingUserInputDraftAnswer> = {};

type InlineMessageEditorProps = Omit<
  ChatComposerProps,
  | "isLocalDraftThread"
  | "isSendBusy"
  | "isPreparingWorktree"
  | "activePendingApproval"
  | "pendingApprovals"
  | "pendingUserInputs"
  | "activePendingProgress"
  | "activePendingResolvedAnswers"
  | "activePendingIsResponding"
  | "activePendingDraftAnswers"
  | "activePendingQuestionIndex"
  | "respondingRequestIds"
  | "showPlanFollowUpPrompt"
  | "activeProposedPlan"
  | "activePlan"
  | "sidebarProposedPlan"
  | "variant"
  | "inlineEdit"
> & {
  isSendBusy: boolean;
  isSubmitting: boolean;
  isPreparing: boolean;
  isRevertingCheckpoint: boolean;
  onCancel: () => void;
};

export function InlineMessageEditor({
  isSendBusy,
  isSubmitting,
  isPreparing,
  isRevertingCheckpoint,
  onCancel,
  ...composerProps
}: InlineMessageEditorProps) {
  return (
    <ChatComposer
      {...composerProps}
      isLocalDraftThread={false}
      isSendBusy={isSendBusy || isSubmitting || isPreparing || isRevertingCheckpoint}
      isPreparingWorktree={false}
      activePendingApproval={null}
      pendingApprovals={EMPTY_PENDING_APPROVALS}
      pendingUserInputs={EMPTY_PENDING_USER_INPUTS}
      activePendingProgress={null}
      activePendingResolvedAnswers={null}
      activePendingIsResponding={false}
      activePendingDraftAnswers={EMPTY_PENDING_USER_INPUT_ANSWERS}
      activePendingQuestionIndex={0}
      respondingRequestIds={EMPTY_APPROVAL_REQUEST_IDS}
      showPlanFollowUpPrompt={false}
      activeProposedPlan={null}
      variant="inline"
      inlineEdit={{
        onCancel,
        isSubmitting,
      }}
    />
  );
}
