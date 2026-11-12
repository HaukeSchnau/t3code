import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  FollowUp,
  FollowUpActor,
  FollowUpId,
  FollowUpLink,
  FollowUpSaveInput,
  FollowUpThreadRef,
  FollowUpType,
} from "@t3tools/contracts";
import {
  CalendarClockIcon,
  CheckIcon,
  ChevronDownIcon,
  RotateCcwIcon,
  Trash2Icon,
  MessageSquarePlusIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useEffectEvent, useRef, useState } from "react";

import { useNowMinute } from "~/hooks/useNowMinute";
import { useClientSettings } from "~/hooks/useSettings";
import { useProject, useThreadShell } from "~/state/entities";
import { followUpEnvironment } from "~/state/followUps";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatChatTimestampTooltip, formatDayAwareTimestamp } from "~/timestampFormat";
import ChatMarkdown from "../ChatMarkdown";
import { requestCustomSnooze } from "../CustomSnoozeDialog";
import { resolveSnoozePresets } from "../Sidebar.snooze";
import { ThreadContextChip } from "../ThreadContextChip";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuItemDetail, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { isFollowUpClosed } from "@t3tools/client-runtime/state/follow-ups";
import { followUpStatusLabel, followUpWhenLabel } from "./followUps.logic";
import { FollowUpProjectPicker } from "./FollowUpProjectPicker";
import { useStartFollowUpThread } from "./useStartFollowUpThread";

const LATER_COPY = {
  title: "Move follow-up",
  description: "Choose when this follow-up comes back to your inbox.",
  durationLabel: "Back in",
  submitLabel: "Move",
};

function statusBadgeVariant(followUp: FollowUp) {
  if (followUp.status === "open") return followUp.returnedAt === null ? "outline" : "warning";
  if (followUp.status === "picked_up") return "info";
  if (followUp.status === "done") return "success";
  return "secondary";
}

function linkKey(link: FollowUpLink): string {
  const target =
    link.target.type === "followUp"
      ? link.target.followUpId
      : `${link.target.environmentId}:${link.target.threadId}`;
  return `${link.kind}:${target}`;
}

function fieldValueText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function Fact(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:gap-4">
      <dt className="w-32 shrink-0 text-muted-foreground">{props.label}</dt>
      <dd className="min-w-0 flex-1">{props.children}</dd>
    </div>
  );
}

function threadChip(ref: FollowUpThreadRef) {
  return (
    <ThreadContextChip
      record={{ environmentId: ref.environmentId, threadId: ref.threadId, title: "Thread" }}
    />
  );
}

function ActorLabel(props: { readonly actor: FollowUpActor }) {
  const { actor } = props;
  if (actor.kind === "user") return <>You</>;
  const name = actor.kind === "gardener" ? "The nightly pass" : "An agent";
  return actor.thread === null ? (
    <>{name}</>
  ) : (
    <span className="inline-flex flex-wrap items-center gap-1">
      {name} in {threadChip(actor.thread)}
    </span>
  );
}

function FollowUpHistory(props: {
  readonly homeEnvironmentId: EnvironmentId;
  readonly followUp: FollowUp;
}) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const history = useEnvironmentQuery(
    followUpEnvironment.history({
      environmentId: props.homeEnvironmentId,
      input: { id: props.followUp.id },
    }),
  );
  const refreshHistory = useEffectEvent(() => history.refresh());
  const updatedAt = props.followUp.updatedAt;
  // A first read is already loading; a cached one is current when it ends with this change.
  const seenUpdatedAt = useRef(history.data === null ? updatedAt : history.data.changes.at(-1)?.at);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refetches the server's change log when the subscribed follow-up changes
  useEffect(() => {
    if (seenUpdatedAt.current === updatedAt) return;
    seenUpdatedAt.current = updatedAt;
    refreshHistory();
  }, [updatedAt]);
  const changes = history.data?.changes ?? [];
  if (changes.length === 0) {
    return history.error ? (
      <p className="text-sm text-muted-foreground">Could not load the history: {history.error}</p>
    ) : null;
  }
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">History</h3>
      <ol className="flex flex-col gap-1.5 text-sm">
        {changes.toReversed().map((change) => (
          <li
            key={`${change.at}:${change.summary}`}
            className="flex flex-wrap items-baseline gap-x-2"
          >
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {formatDayAwareTimestamp(change.at, timestampFormat)}
            </span>
            <span className="min-w-0">
              <ActorLabel actor={change.actor} />: {change.summary}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function LaterMenu(props: {
  readonly homeEnvironmentId: EnvironmentId;
  readonly hasDate: boolean;
  readonly disabled: boolean;
  readonly onMove: (dueAt: string | null) => void;
}) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const [open, setOpen] = useState(false);
  const presets = open
    ? // oxlint-disable-next-line react/purity -- Presets are resolved only while the menu is open, so each opening reads a fresh time.
      resolveSnoozePresets(new Date(), timestampFormat, props.homeEnvironmentId)
    : [];
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger render={<Button size="sm" variant="outline" disabled={props.disabled} />}>
        <CalendarClockIcon />
        Later
        <ChevronDownIcon />
      </MenuTrigger>
      <MenuPopup align="start">
        {presets.map((preset) => (
          <MenuItem key={preset.id} onClick={() => props.onMove(preset.snoozedUntil)}>
            {preset.label}
            <MenuItemDetail>{preset.whenLabel}</MenuItemDetail>
          </MenuItem>
        ))}
        {presets.length > 0 ? <MenuSeparator /> : null}
        <MenuItem
          onClick={async () => {
            const choice = await requestCustomSnooze(LATER_COPY);
            if (choice) props.onMove(choice.snoozedUntil);
          }}
        >
          Pick a date…
        </MenuItem>
        {props.hasDate ? (
          <MenuItem onClick={() => props.onMove(null)}>Clear the date</MenuItem>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

function DonePopover(props: {
  readonly disabled: boolean;
  /** Resolves whether the save went through; the popover keeps the text until it does. */
  readonly onDone: (result: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState("");
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setResult("");
      }}
    >
      <PopoverTrigger render={<Button size="sm" variant="outline" disabled={props.disabled} />}>
        <CheckIcon />
        Done
      </PopoverTrigger>
      <PopoverPopup align="start" width="md">
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (props.disabled) return;
            void props.onDone(result.trim()).then((saved) => {
              if (!saved) return;
              setOpen(false);
              setResult("");
            });
          }}
        >
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            What came of it? (optional)
            <Textarea
              rows={3}
              value={result}
              onChange={(event) => setResult(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
          </label>
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={props.disabled}>
              Mark done
            </Button>
          </div>
        </form>
      </PopoverPopup>
    </Popover>
  );
}

function FollowUpActions(props: {
  readonly homeEnvironmentId: EnvironmentId;
  readonly followUp: FollowUp;
}) {
  const { homeEnvironmentId, followUp } = props;
  const canSave = useAtomValue(followUpEnvironment.save.permissionAtom(homeEnvironmentId));
  const save = useAtomCommand(followUpEnvironment.save, { reportFailure: false });
  const startThread = useStartFollowUpThread();
  const [busy, setBusy] = useState(false);
  const originShell = useThreadShell(
    followUp.origin === null
      ? null
      : scopeThreadRef(followUp.origin.environmentId, followUp.origin.threadId),
  );
  const originProject = useProject(
    originShell === null ? null : scopeProjectRef(originShell.environmentId, originShell.projectId),
  );
  const disabled = busy || !canSave;

  const apply = async (patch: Omit<FollowUpSaveInput, "id">): Promise<boolean> => {
    setBusy(true);
    const result = await save({
      environmentId: homeEnvironmentId,
      input: { id: followUp.id, ...patch },
    });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not update the follow-up",
        description: failure instanceof Error ? failure.message : "An error occurred.",
      });
    }
    return result._tag === "Success";
  };
  const start = async (project: EnvironmentProject) => {
    setBusy(true);
    await startThread({ homeEnvironmentId, followUp, project });
    setBusy(false);
  };

  if (isFollowUpClosed(followUp)) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => void apply({ status: "open" })}
        >
          <RotateCcwIcon />
          Reopen
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {originProject !== null ? (
        <Button size="sm" disabled={disabled} onClick={() => void start(originProject)}>
          <MessageSquarePlusIcon />
          Start a thread
        </Button>
      ) : (
        <FollowUpProjectPicker disabled={disabled} onPick={(project) => void start(project)} />
      )}
      <DonePopover
        disabled={disabled}
        onDone={(result) => apply({ status: "done", ...(result === "" ? {} : { result }) })}
      />
      <LaterMenu
        homeEnvironmentId={homeEnvironmentId}
        hasDate={followUp.dueAt !== null}
        disabled={disabled}
        // A picked-up follow-up only comes back once it is open again.
        onMove={(dueAt) =>
          void apply({ dueAt, ...(followUp.status === "picked_up" ? { status: "open" } : {}) })
        }
      />
      <Button
        size="sm"
        variant="ghost-destructive"
        disabled={disabled}
        onClick={() => void apply({ status: "dropped" })}
      >
        <Trash2Icon />
        Drop
      </Button>
    </div>
  );
}

export function FollowUpDetail(props: {
  readonly homeEnvironmentId: EnvironmentId;
  readonly followUp: FollowUp;
  readonly types: ReadonlyArray<FollowUpType>;
  /** Titles of the follow-ups this store holds, for its links. */
  readonly titleOf: (id: FollowUpId) => string | null;
  readonly onOpenFollowUp: (id: FollowUpId) => void;
}) {
  const { followUp, homeEnvironmentId } = props;
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const nowMinute = useNowMinute();
  const when = followUpWhenLabel(followUp, timestampFormat, Date.parse(`${nowMinute}:00.000Z`));
  const type = props.types.find((candidate) => candidate.name === followUp.type) ?? null;
  const fields = Object.entries(followUp.fields);
  const fieldDescription = (name: string) =>
    type?.fields.find((field) => field.name === name)?.description ?? undefined;

  return (
    <article className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={statusBadgeVariant(followUp)}>
            {followUp.status === "open" && followUp.returnedAt !== null
              ? "Back now"
              : followUpStatusLabel(followUp.status)}
          </Badge>
          {followUp.type !== null ? <Badge variant="outline">{followUp.type}</Badge> : null}
          {followUp.tags.map((tag) => (
            <Badge key={tag} variant="secondary">
              {tag}
            </Badge>
          ))}
        </div>
        <h2 className="text-xl font-semibold text-balance">{followUp.title}</h2>
        {when !== null ? <p className="text-sm text-muted-foreground">{when}</p> : null}
        <FollowUpActions homeEnvironmentId={homeEnvironmentId} followUp={followUp} />
      </header>

      {followUp.body.trim() !== "" ? (
        <ChatMarkdown text={followUp.body} cwd={undefined} environmentId={homeEnvironmentId} />
      ) : null}

      <dl className="flex flex-col gap-3 text-sm">
        {followUp.origin !== null ? (
          <Fact label="Came from">
            <div className="flex flex-col items-start gap-2">
              <ThreadContextChip
                record={{
                  environmentId: followUp.origin.environmentId,
                  threadId: followUp.origin.threadId,
                  title: followUp.origin.threadTitle ?? "Thread",
                }}
              />
              {followUp.origin.quote !== null ? (
                <blockquote className="border-l-2 border-border ps-3 whitespace-pre-wrap text-muted-foreground">
                  {followUp.origin.quote}
                </blockquote>
              ) : null}
            </div>
          </Fact>
        ) : null}
        {followUp.dueAt !== null ? (
          <Fact label="Date">{formatChatTimestampTooltip(followUp.dueAt, timestampFormat)}</Fact>
        ) : null}
        {followUp.condition !== null && when !== followUp.condition ? (
          <Fact label="When">{followUp.condition}</Fact>
        ) : null}
        {followUp.pickedUpThread !== null ? (
          <Fact label="Picked up in">{threadChip(followUp.pickedUpThread)}</Fact>
        ) : null}
        {followUp.result !== null && followUp.result.trim() !== "" ? (
          <Fact label="Result">
            <ChatMarkdown
              text={followUp.result}
              cwd={undefined}
              environmentId={homeEnvironmentId}
            />
          </Fact>
        ) : null}
        {followUp.mergedInto !== null ? (
          <Fact label="Merged into">
            <FollowUpLinkButton
              id={followUp.mergedInto}
              title={props.titleOf(followUp.mergedInto)}
              onOpen={props.onOpenFollowUp}
            />
          </Fact>
        ) : null}
        {followUp.links.length > 0 ? (
          <Fact label="Links">
            <ul className="flex flex-col gap-1.5">
              {followUp.links.map((link) => (
                <li key={linkKey(link)} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-muted-foreground">{link.kind}</span>
                  {link.target.type === "followUp" ? (
                    <FollowUpLinkButton
                      id={link.target.followUpId}
                      title={props.titleOf(link.target.followUpId)}
                      onOpen={props.onOpenFollowUp}
                    />
                  ) : (
                    threadChip({
                      environmentId: link.target.environmentId,
                      threadId: link.target.threadId,
                    })
                  )}
                </li>
              ))}
            </ul>
          </Fact>
        ) : null}
        {fields.map(([name, value]) => {
          const description = fieldDescription(name);
          return (
            <Fact key={name} label={name}>
              <span className="break-words whitespace-pre-wrap">{fieldValueText(value)}</span>
              {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
            </Fact>
          );
        })}
        <Fact label="Written by">
          <span className="inline-flex flex-wrap items-center gap-1">
            <ActorLabel actor={followUp.createdBy} />,{" "}
            {formatDayAwareTimestamp(followUp.createdAt, timestampFormat)}
          </span>
        </Fact>
      </dl>

      <FollowUpHistory homeEnvironmentId={homeEnvironmentId} followUp={followUp} />
    </article>
  );
}

function FollowUpLinkButton(props: {
  readonly id: FollowUpId;
  readonly title: string | null;
  readonly onOpen: (id: FollowUpId) => void;
}) {
  return (
    <Button size="xs" variant="link" onClick={() => props.onOpen(props.id)}>
      {props.title ?? props.id}
    </Button>
  );
}
