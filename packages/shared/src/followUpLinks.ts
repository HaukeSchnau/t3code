import { EnvironmentId, FollowUpId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { markdownLinkLabel } from "./threadLinks.ts";

export const FOLLOW_UP_LINK_PROTOCOL = "t3-follow-up";
const PREFIX = `${FOLLOW_UP_LINK_PROTOCOL}://`;

/** A follow-up in the home environment that keeps it (patches/follow-ups.md). */
export interface FollowUpRef {
  readonly environmentId: EnvironmentId;
  readonly followUpId: FollowUpId;
}

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeFollowUpId = Schema.decodeUnknownOption(FollowUpId);

export function followUpLinkHref(ref: FollowUpRef): string {
  return `${PREFIX}${ref.environmentId}/${ref.followUpId}`;
}

export function parseFollowUpLinkHref(href: string): FollowUpRef | null {
  if (!href.startsWith(PREFIX)) return null;
  const path = href.slice(PREFIX.length);
  const slash = path.indexOf("/");
  if (slash < 0) return null;
  const environmentId = Option.getOrNull(decodeEnvironmentId(path.slice(0, slash)));
  const followUpId = Option.getOrNull(decodeFollowUpId(path.slice(slash + 1)));
  return environmentId === null || followUpId === null ? null : { environmentId, followUpId };
}

/** Clients show it as a chip with the follow-up's current title; `label` is what others read. */
export function formatFollowUpLink(ref: FollowUpRef, label: string): string {
  return `[${markdownLinkLabel(label) || ref.followUpId}](${followUpLinkHref(ref)})`;
}

/** Every follow-up link in the markdown, code included, so the chips can read them. */
export function followUpLinkHrefs(markdown: string): ReadonlyArray<string> {
  if (!markdown.includes(PREFIX)) return [];
  const hrefs = new Set<string>();
  for (const [href] of markdown.matchAll(/t3-follow-up:\/\/[^\s<>()[\]]+/g)) {
    if (parseFollowUpLinkHref(href) !== null) hrefs.add(href);
  }
  return [...hrefs];
}
