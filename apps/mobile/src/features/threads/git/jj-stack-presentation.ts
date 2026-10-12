import {
  buildJjStackView,
  jjBreadcrumbParts,
  type JjStackView,
} from "@t3tools/client-runtime/state/vcs";
import type { VcsStatusResult } from "@t3tools/contracts";

/** The thread's jj stack, or null when the workspace is not a jj repository. */
export function jjStackViewFromStatus(
  status: Pick<VcsStatusResult, "kind" | "jj"> | null | undefined,
  threadId: string | null,
): JjStackView | null {
  if (status?.kind !== "jj" || status.jj === undefined) {
    return null;
  }
  return buildJjStackView(status.jj, threadId);
}

export function jjBreadcrumb(view: JjStackView): string {
  return jjBreadcrumbParts(view).join(" › ");
}

/** Where Push would land: the push target's bookmark, or that it has none yet. */
export function jjPushState(view: JjStackView): string {
  const target = view.pushTarget;
  if (target === null) {
    return "Nothing to push";
  }
  const bookmark = target.bookmarks[0];
  if (bookmark === undefined) {
    return "Not pushed";
  }
  return target.pushed ? bookmark : `${bookmark} · not pushed`;
}
