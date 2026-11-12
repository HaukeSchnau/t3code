import type { SnoozePresetSetting } from "@t3tools/contracts/settings";
import type { FollowUp, FollowUpActor, FollowUpStatus } from "@t3tools/contracts";

import type { AppSymbolName } from "../../components/ui/AppSymbol";

export const FOLLOW_UP_ICON = "tray.and.arrow.down" satisfies AppSymbolName;

/** The Later menu: the snooze presets' rules, so "Next week" means the same in both menus. */
export const FOLLOW_UP_LATER_PRESETS: ReadonlyArray<SnoozePresetSetting> = [
  { kind: "at", day: "tomorrow", time: "09:00" },
  { kind: "at", day: "monday", time: "09:00" },
  { kind: "after", minutes: 30 * 24 * 60 },
];

export const FOLLOW_UP_STATUS_LABELS: Readonly<Record<FollowUpStatus, string>> = {
  open: "Open",
  picked_up: "Picked up",
  done: "Done",
  dropped: "Dropped",
  merged: "Merged",
};

export function formatFollowUpDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** When it comes back: its date, else the moment it waits for. */
function followUpWhenLabel(followUp: FollowUp): string | null {
  if (followUp.dueAt !== null) return formatFollowUpDate(followUp.dueAt);
  return followUp.condition;
}

export function followUpActorLabel(actor: FollowUpActor): string {
  return actor.kind === "user" ? "You" : actor.kind === "gardener" ? "Gardener" : "Agent";
}

/** The row's second line: type, tags, date or condition, and where it came from. */
export function followUpRowDescription(followUp: FollowUp): string {
  const origin =
    followUp.origin !== null
      ? `From ${followUp.origin.threadTitle ?? "a thread"}`
      : followUp.createdBy.kind === "user"
        ? "Added by you"
        : followUp.createdBy.kind === "gardener"
          ? "Added by the gardener"
          : "Added by an agent";
  return [
    followUp.type,
    followUp.tags.length > 0 ? followUp.tags.map((tag) => `#${tag}`).join(" ") : null,
    followUpWhenLabel(followUp),
    origin,
  ]
    .filter((part): part is string => part !== null && part !== "")
    .join(" · ");
}

export function followUpFieldValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
