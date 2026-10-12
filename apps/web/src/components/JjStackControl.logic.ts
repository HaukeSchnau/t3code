import type { JjStackRow, JjStackView } from "@t3tools/client-runtime/state/vcs";
import type { JjAction, JjChangeFlag, JjRunActionResult } from "@t3tools/contracts";

export const JJ_FLAG_DESCRIPTIONS = {
  mixed: "Two turns edited a file before it was sealed, so this change holds both.",
  swept: "An agent committed files another thread had edited.",
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

export function jjStackActions(view: JjStackView, hasTrunk: boolean): ReadonlyArray<JjStackAction> {
  const target = view.pushTarget === null ? {} : { changeId: view.pushTarget.changeId };
  const workingCopyEmpty = view.workingCopy?.empty ?? true;
  return [
    { label: "New change", action: { _tag: "new" }, disabled: false },
    { label: "Fetch", action: { _tag: "fetch" }, disabled: false },
    { label: "Rebase onto trunk", action: { _tag: "rebase" }, disabled: !hasTrunk },
    { label: "Absorb", action: { _tag: "absorb" }, disabled: workingCopyEmpty },
    { label: "Push", action: { _tag: "push", ...target }, disabled: view.pushTarget === null },
    { label: "Create PR", action: { _tag: "pr", ...target }, disabled: view.pushTarget === null },
    { label: "Undo last T3 operation", action: { _tag: "undo" }, disabled: false },
  ];
}

export function jjActionToast(result: Pick<JjRunActionResult, "summary" | "conflictedChanges">) {
  const conflicts = result.conflictedChanges.length;
  if (conflicts === 0) return { type: "success" as const, title: result.summary };
  return {
    type: "warning" as const,
    title: result.summary,
    description:
      conflicts === 1 ? "1 change now has conflicts." : `${conflicts} changes now have conflicts.`,
  };
}
