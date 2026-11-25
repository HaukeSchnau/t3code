import { isOptionalPendingUserInput } from "@t3tools/client-runtime/state/pending-user-input";
import { T } from "gt-react";

import { type PendingUserInput } from "../../session-logic";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

// Codex marks non-blocking questions optional (patches/codex-structured-user-input.md).

export function OptionalQuestionBadge({ prompt }: { prompt: PendingUserInput }) {
  if (!isOptionalPendingUserInput(prompt.questions)) return null;
  return (
    <Badge variant="secondary" size="sm">
      <T context="a question the agent marked as not required">Optional</T>
    </Badge>
  );
}

/** Answers with nothing, so the agent continues on its own judgment. */
export function OptionalQuestionSkip({
  prompt,
  disabled,
  onSkip,
}: {
  prompt: PendingUserInput;
  disabled: boolean;
  onSkip: (() => void) | undefined;
}) {
  // A dismissible question already has a Skip that dismisses it.
  if (!onSkip || prompt.dismissible || !isOptionalPendingUserInput(prompt.questions)) return null;
  return (
    <Button size="sm" variant="secondary" disabled={disabled} onClick={onSkip}>
      <T context="verb, skip this question">Skip</T>
    </Button>
  );
}
