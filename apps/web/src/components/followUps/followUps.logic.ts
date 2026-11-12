import { groupFollowUps, isFollowUpClosed } from "@t3tools/client-runtime/state/follow-ups";
import type {
  EnvironmentId,
  FollowUp,
  FollowUpStatus,
  FollowUpThreadRef,
} from "@t3tools/contracts";
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

export type FollowUpGraphNode =
  | {
      readonly kind: "followUp";
      readonly key: string;
      readonly homeEnvironmentId: EnvironmentId;
      readonly followUp: FollowUp;
    }
  | {
      readonly kind: "thread";
      readonly key: string;
      readonly thread: FollowUpThreadRef;
      /** The title an origin recorded, for threads this client has no shell for. */
      readonly recordedTitle: string | null;
    };

interface FollowUpGraphEdge {
  readonly key: string;
  readonly from: string;
  readonly to: string;
  /** Every relation from one node to the other, so they share one line. */
  readonly labels: ReadonlyArray<string>;
}

export interface FollowUpGraph {
  /** Threads first, so follow-ups draw on top of them. */
  readonly nodes: ReadonlyArray<FollowUpGraphNode>;
  readonly edges: ReadonlyArray<FollowUpGraphEdge>;
  /** Changes only when a node or edge comes or goes, which is all the layout depends on. */
  readonly shape: string;
}

export function followUpGraphKey(homeEnvironmentId: EnvironmentId, id: string): string {
  return `followUp:${homeEnvironmentId}:${id}`;
}

/**
 * Follow-ups and the threads they name, joined by their links, origin, pick-up and merge.
 * Closed follow-ups join only when shown; relations to follow-ups that are not shown drop out.
 */
export function buildFollowUpGraph(
  stores: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly followUps: ReadonlyArray<FollowUp>;
  }>,
  showClosed: boolean,
): FollowUpGraph {
  const followUpNodes = new Map<string, Extract<FollowUpGraphNode, { kind: "followUp" }>>();
  for (const store of stores) {
    for (const followUp of store.followUps) {
      if (!showClosed && isFollowUpClosed(followUp)) continue;
      const key = followUpGraphKey(store.environmentId, followUp.id);
      followUpNodes.set(key, {
        kind: "followUp",
        key,
        homeEnvironmentId: store.environmentId,
        followUp,
      });
    }
  }
  const threadNodes = new Map<string, Extract<FollowUpGraphNode, { kind: "thread" }>>();
  const edges = new Map<string, { key: string; from: string; to: string; labels: string[] }>();
  const thread = (ref: FollowUpThreadRef, recordedTitle: string | null = null) => {
    const key = `thread:${ref.environmentId}:${ref.threadId}`;
    const existing = threadNodes.get(key);
    if (existing === undefined || (existing.recordedTitle === null && recordedTitle !== null)) {
      threadNodes.set(key, {
        kind: "thread",
        key,
        thread: { environmentId: ref.environmentId, threadId: ref.threadId },
        recordedTitle,
      });
    }
    return key;
  };
  const relate = (from: string, to: string, label: string) => {
    if (from === to) return;
    const key = `${from}>${to}`;
    const edge = edges.get(key);
    if (edge === undefined) edges.set(key, { key, from, to, labels: [label] });
    else if (!edge.labels.includes(label)) edge.labels.push(label);
  };
  for (const node of followUpNodes.values()) {
    const { followUp, homeEnvironmentId } = node;
    const shownFollowUp = (id: string) => {
      const key = followUpGraphKey(homeEnvironmentId, id);
      return followUpNodes.has(key) ? key : null;
    };
    if (followUp.origin !== null) {
      relate(node.key, thread(followUp.origin, followUp.origin.threadTitle), "came from");
    }
    if (followUp.pickedUpThread !== null) {
      relate(node.key, thread(followUp.pickedUpThread), "picked up in");
    }
    const mergedInto = followUp.mergedInto === null ? null : shownFollowUp(followUp.mergedInto);
    if (mergedInto !== null) relate(node.key, mergedInto, "merged into");
    for (const link of followUp.links) {
      const target =
        link.target.type === "thread" ? thread(link.target) : shownFollowUp(link.target.followUpId);
      if (target !== null) relate(node.key, target, link.kind);
    }
  }
  const nodes = [...threadNodes.values(), ...followUpNodes.values()];
  const edgeList = [...edges.values()];
  return {
    nodes,
    edges: edgeList,
    shape: [
      ...nodes.map((node) => node.key).toSorted(),
      "",
      ...edgeList.map((edge) => edge.key).toSorted(),
    ].join("\n"),
  };
}
