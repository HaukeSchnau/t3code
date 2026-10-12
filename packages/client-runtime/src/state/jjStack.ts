import type { JjChangeFlag, JjStackEntry, JjStatus } from "@t3tools/contracts";

export interface JjStackRow {
  readonly changeId: string;
  readonly shortChangeId: string;
  readonly title: string;
  readonly undescribed: boolean;
  readonly empty: boolean;
  readonly conflict: boolean;
  readonly workingCopy: boolean;
  readonly bookmarks: ReadonlyArray<string>;
  readonly pushed: boolean;
  /** "turn 2", "turns 1-3", or null for changes no turn described. */
  readonly turnLabel: string | null;
  readonly ownership: "this-thread" | "other-thread" | "untagged";
  readonly flags: ReadonlyArray<JjChangeFlag>;
}

export interface JjStackView {
  /** Where the stack starts, like `main@origin`. */
  readonly base: string;
  /** Non-empty changes above the base, `@` included. */
  readonly changeCount: number;
  readonly workingCopy: JjStackRow | null;
  readonly rows: ReadonlyArray<JjStackRow>;
  readonly conflictCount: number;
  readonly unattributed: ReadonlyArray<string>;
  /** The change Push and Create PR act on: `@` unless it is empty, else its parent. */
  readonly pushTarget: JjStackRow | null;
}

export function formatJjTurns(turns: ReadonlyArray<number>): string | null {
  const sorted = [...new Set(turns)].sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return `turn ${sorted[0]}`;
  const consecutive = sorted.every((turn, index) => index === 0 || turn === sorted[index - 1]! + 1);
  return consecutive ? `turns ${sorted[0]}-${sorted.at(-1)}` : `turns ${sorted.join(", ")}`;
}

function toRow(entry: JjStackEntry, threadId: string | null): JjStackRow {
  return {
    changeId: entry.changeId,
    shortChangeId: entry.changeId.slice(0, 8),
    title: entry.description.length > 0 ? entry.description : "(no description)",
    undescribed: entry.description.length === 0,
    empty: entry.empty,
    conflict: entry.conflict,
    workingCopy: entry.workingCopy,
    bookmarks: entry.bookmarks,
    pushed: entry.pushed,
    turnLabel: formatJjTurns(entry.turns),
    ownership:
      entry.threadId === null
        ? "untagged"
        : threadId !== null && entry.threadId === threadId
          ? "this-thread"
          : "other-thread",
    flags: entry.flags,
  };
}

export function buildJjStackView(status: JjStatus, threadId: string | null): JjStackView {
  const rows = status.stack.map((entry) => toRow(entry, threadId));
  const workingCopy = rows.find((row) => row.workingCopy) ?? null;
  const pushTarget =
    workingCopy !== null && !workingCopy.empty
      ? workingCopy
      : (rows.find((row) => !row.workingCopy && !row.empty) ?? null);
  return {
    base: status.trunk?.label ?? "root",
    changeCount: rows.filter((row) => !row.empty).length,
    workingCopy,
    rows,
    conflictCount: rows.filter((row) => row.conflict).length,
    unattributed: status.unattributed,
    pushTarget,
  };
}

/** `main › 2 changes › @ kxqv`, the stack breadcrumb. */
export function jjBreadcrumbParts(view: JjStackView): readonly [string, string, string] {
  return [
    view.base,
    view.changeCount === 1 ? "1 change" : `${view.changeCount} changes`,
    `@ ${view.workingCopy?.changeId.slice(0, 4) ?? "?"}`,
  ];
}
