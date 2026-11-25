import { useAtomValue } from "@effect/atom-react";
import type { AssistantCitation, MessageId, ScopedThreadRef } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { ListTodoIcon } from "lucide-react";
import { useState } from "react";

import { followUpEnvironment, followUpHomeOfAtom } from "~/state/followUps";
import { Button } from "../ui/button";
import { QuoteFollowUpDialog } from "./QuoteFollowUpDialog";

/**
 * Quote to follow-up for the selection toolbar. Starting one clears the selection, which hides
 * the toolbar, so the toolbar renders `dialog` from its no-selection branch.
 */
export function useQuoteFollowUp(threadRef: ScopedThreadRef) {
  const home = useAtomValue(followUpHomeOfAtom(threadRef.environmentId));
  const canSave = useAtomValue(followUpEnvironment.save.permissionAtom(home));
  const [pending, setPending] = useState<{
    threadRef: ScopedThreadRef;
    messageId: MessageId;
    quote: string;
  } | null>(null);

  const dialog = pending ? (
    <QuoteFollowUpDialog
      threadRef={pending.threadRef}
      messageId={pending.messageId}
      quote={pending.quote}
      onClose={() => setPending((current) => (current === pending ? null : current))}
    />
  ) : null;
  const start = (citation: AssistantCitation) =>
    setPending({ threadRef, messageId: citation.messageId, quote: citation.text.trim() });

  return { canSave, dialog, start };
}

export function QuoteFollowUpButton({
  followUp,
  citation,
  onDone,
}: {
  followUp: ReturnType<typeof useQuoteFollowUp>;
  citation: AssistantCitation;
  onDone: () => void;
}) {
  const gt = useGT();
  if (!followUp.canSave) return null;
  return (
    <Button
      variant="ghost"
      size="xs"
      aria-label={gt("Save selection as a follow-up")}
      onClick={() => {
        followUp.start(citation);
        window.getSelection()?.removeAllRanges();
        onDone();
      }}
    >
      <ListTodoIcon aria-hidden="true" />
      {gt("Follow-up", { $context: "button that saves the selected text for later" })}
    </Button>
  );
}
