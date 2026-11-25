import { useAtomValue } from "@effect/atom-react";
import {
  followUpLinkHref,
  formatFollowUpLink,
  type FollowUpRef,
} from "@t3tools/shared/followUpLinks";
import { Link } from "@tanstack/react-router";
import { ListTodoIcon } from "lucide-react";
import { T, useGT, useMessages } from "gt-react";

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
  const gt = useGT();
  const m = useMessages();
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
      ? followUpStatusLabel(linked.status, m)
      : null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ContextChip
            kind="follow-up"
            render={<Link to="/follow-ups" search={search} />}
            aria-label={
              status === null
                ? gt("Follow-up, {title}", { title })
                : gt("Follow-up, {title}, {status}", { title, status })
            }
            data-markdown-copy={formatFollowUpLink(props.link, title)}
            className="no-underline"
          >
            <ListTodoIcon />
            <ContextChipLabel>{title}</ContextChipLabel>
            {status !== null ? (
              <span className="ms-0.5 shrink-0 self-baseline text-caption opacity-80">
                {status}
              </span>
            ) : null}
          </ContextChip>
        }
      />
      <TooltipPopup side="top">
        <T>Open follow-up</T>
      </TooltipPopup>
    </Tooltip>
  );
}
