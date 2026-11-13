import { useAtomValue } from "@effect/atom-react";
import {
  followUpLinkHref,
  formatFollowUpLink,
  type FollowUpRef,
} from "@t3tools/shared/followUpLinks";
import { Link } from "@tanstack/react-router";
import { ListTodoIcon } from "lucide-react";

import { linkedFollowUpAtom } from "~/state/followUps";
import { ContextChip, ContextChipLabel } from "../ContextChip";
import { followUpStatusLabel } from "../followUps/followUps.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * A chip with the follow-up's current title and status. One whose home isn't connected, or that
 * is gone, stays a plain link with the text the agent wrote.
 */
export function MarkdownFollowUpLink(props: {
  readonly link: FollowUpRef;
  /** The link's written text; an autolink has none. */
  readonly label: string | null;
}) {
  const { environmentId, followUpId } = props.link;
  const linked = useAtomValue(linkedFollowUpAtom(followUpLinkHref(props.link)));
  const search = { home: environmentId, id: followUpId };
  const written = props.label?.trim() || followUpId;
  if (linked.state === "missing") {
    return (
      <Link to="/follow-ups" search={search}>
        {written}
      </Link>
    );
  }
  const title = linked.state === "found" ? linked.title.trim() || written : written;
  const status =
    linked.state === "found" && linked.status !== "open"
      ? followUpStatusLabel(linked.status)
      : null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ContextChip
            kind="follow-up"
            render={<Link to="/follow-ups" search={search} />}
            aria-label={`Follow-up, ${title}${status === null ? "" : `, ${status}`}`}
            data-markdown-copy={formatFollowUpLink(props.link, title)}
            className="no-underline"
          >
            <ListTodoIcon />
            <ContextChipLabel>{title}</ContextChipLabel>
            {status !== null ? (
              <span className="shrink-0 self-baseline text-3xs opacity-80">· {status}</span>
            ) : null}
          </ContextChip>
        }
      />
      <TooltipPopup side="top">Open follow-up</TooltipPopup>
    </Tooltip>
  );
}
