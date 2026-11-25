import type { JjStackRow, JjStackView } from "@t3tools/client-runtime/state/vcs";
import type { JjAction, JjChangeFlag, JjRunActionResult } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../i18n/messages";

export const JJ_FLAG_DESCRIPTIONS = {
  mixed: msg("Two turns edited a file before it was sealed, so this change holds both."),
  swept: msg("An agent committed files another thread had edited."),
} as const satisfies Record<JjChangeFlag, string>;

export function jjRowActions(view: JjStackView, row: JjStackRow) {
  const index = view.rows.findIndex((candidate) => candidate.changeId === row.changeId);
  return {
    // The oldest change sits on trunk, which jj will not rewrite.
    squash: index !== -1 && index < view.rows.length - 1,
    edit: !row.workingCopy,
  };
}

export interface JjStackAction {
  readonly label: string;
  readonly action: JjAction;
  readonly disabled: boolean;
}

export function jjStackActions(
  view: JjStackView,
  hasTrunk: boolean,
  resolve: MessageResolver = m,
): ReadonlyArray<JjStackAction> {
  const target = view.pushTarget === null ? {} : { changeId: view.pushTarget.changeId };
  const workingCopyEmpty = view.workingCopy?.empty ?? true;
  return [
    { label: resolve(msg("New change")), action: { _tag: "new" }, disabled: false },
    {
      label: resolve(msg("Fetch", { $context: "verb, jj fetch" })),
      action: { _tag: "fetch" },
      disabled: false,
    },
    { label: resolve(msg("Rebase onto trunk")), action: { _tag: "rebase" }, disabled: !hasTrunk },
    {
      label: resolve(msg("Absorb", { $context: "verb, jj absorb" })),
      action: { _tag: "absorb" },
      disabled: workingCopyEmpty,
    },
    {
      label: resolve(msg("Push", { $context: "verb, jj git push" })),
      action: { _tag: "push", ...target },
      disabled: view.pushTarget === null,
    },
    {
      label: resolve(msg("Create PR")),
      action: { _tag: "pr", ...target },
      disabled: view.pushTarget === null,
    },
    { label: resolve(msg("Undo last T3 operation")), action: { _tag: "undo" }, disabled: false },
  ];
}

export function jjActionToast(
  result: Pick<JjRunActionResult, "summary" | "conflictedChanges">,
  resolve: MessageResolver = m,
) {
  const conflicts = result.conflictedChanges.length;
  if (conflicts === 0) return { type: "success" as const, title: result.summary };
  return {
    type: "warning" as const,
    title: result.summary,
    description: resolve(
      msg(
        "{conflicts, plural, one {{conflicts} change now has conflicts.} other {{conflicts} changes now have conflicts.}}",
        { conflicts },
      ),
    ),
  };
}
