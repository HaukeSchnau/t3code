import { groupFollowUps, isFollowUpClosed } from "@t3tools/client-runtime/state/follow-ups";
import type { FollowUp, FollowUpStatus } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";

import { formatRelativeTimeLabel, formatUpcomingTimestamp } from "../../timestampFormat";

interface FollowUpSection {
  readonly key: "returned" | "open" | "picked_up" | "closed";
  readonly label: string;
  readonly followUps: ReadonlyArray<FollowUp>;
}

/** The page's sections, in the order to act on them; empty ones are left out. */
export function followUpSections(
  followUps: ReadonlyArray<FollowUp>,
  showClosed: boolean,
): ReadonlyArray<FollowUpSection> {
  const groups = groupFollowUps(followUps);
  const sections: ReadonlyArray<FollowUpSection> = [
    { key: "returned", label: "Back now", followUps: groups.backNow },
    { key: "open", label: "Open", followUps: groups.open },
    { key: "picked_up", label: "Picked up", followUps: groups.pickedUp },
    { key: "closed", label: "Closed", followUps: showClosed ? groups.closed : [] },
  ];
  return sections.filter((section) => section.followUps.length > 0);
}

const STATUS_LABELS: Record<FollowUpStatus, string> = {
  open: "Open",
  picked_up: "Picked up",
  done: "Done",
  dropped: "Dropped",
  merged: "Merged",
};

export function followUpStatusLabel(status: FollowUpStatus): string {
  return STATUS_LABELS[status];
}

/** The one line that says when a follow-up matters: back, due, a condition, or how it closed. */
export function followUpWhenLabel(
  followUp: FollowUp,
  timestampFormat: TimestampFormat,
  nowMs: number,
): string | null {
  if (isFollowUpClosed(followUp)) {
    return followUp.closedAt === null
      ? STATUS_LABELS[followUp.status]
      : `${STATUS_LABELS[followUp.status]} ${formatRelativeTimeLabel(followUp.closedAt, nowMs)}`;
  }
  if (followUp.status === "picked_up") return STATUS_LABELS.picked_up;
  if (followUp.returnedAt !== null) {
    return `Back ${formatRelativeTimeLabel(followUp.returnedAt, nowMs)}`;
  }
  if (followUp.dueAt !== null) {
    return `Due ${formatUpcomingTimestamp(followUp.dueAt, timestampFormat, nowMs)}`;
  }
  return followUp.condition;
}
