import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EMPTY_NEEDS_YOU_DECK,
  makeNeedsYouDraftStore,
  needsYouDeckIndex,
  needsYouDeckKey,
  needsYouDeckThreads,
  reconcileNeedsYouDeck,
  stepNeedsYouDeck,
} from "@t3tools/client-runtime/state/needs-you-triage";
import { selectProjectGroupingSettings } from "@t3tools/client-runtime/state/project-grouping";
import { ChevronLeftIcon, ChevronRightIcon, InboxIcon } from "lucide-react";
import { useState, useSyncExternalStore } from "react";

import { durableCommandOutbox } from "~/durableCommandOutbox";
import { useNowMinute } from "~/hooks/useNowMinute";
import { useClientSettings } from "~/hooks/useSettings";
import { useSidebarProjectGroups } from "~/hooks/useSidebarProjectGroups";
import { resolveSidebarProjectScope } from "~/sidebarProjectGrouping";
import {
  useAllEnvironmentProjectSnapshotsReady,
  useDelegatedUnderParent,
  useQuietThreadShells,
  useServerConfigs,
} from "~/state/entities";
import { environmentProjects } from "~/state/projects";
import { useUiStateStore } from "~/uiStateStore";

import { AppRouteModal, AppRouteModalClose } from "../AppRouteModal";
import { filterSidebarV2VisibleThreads, useSnoozeWakeClock } from "../Sidebar.logic";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Kbd } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { TriageCard } from "./TriageCard";
import { triageEscapeCloses, triageKeyTarget } from "./triageKeys";

const triageDrafts = makeNeedsYouDraftStore({
  holds: (messageId) =>
    durableCommandOutbox()
      .entries()
      .some((entry) => entry.command.messageId === messageId),
  subscribe: (listener) => durableCommandOutbox().subscribe(listener),
});

/**
 * The sidebar's Needs you section: its project filter, the threads it lists, and its snooze rule
 * (a snooze counts once the environment's config has loaded).
 */
function useNeedsYouDeckThreads() {
  const threads = useQuietThreadShells();
  const delegatedUnderParent = useDelegatedUnderParent();
  const serverConfigs = useServerConfigs();
  const projectGroups = useSidebarProjectGroups();
  const scopeKeys = useUiStateStore((store) => store.sidebarProjectScopeKeys);
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  const snapshotsReady = useAllEnvironmentProjectSnapshotsReady();
  const configsReady = useAtomValue(environmentProjects.projectConfigsReadyAtom);
  const nowMinute = useNowMinute();
  const snoozeWakeClock = useSnoozeWakeClock(threads);
  const { projectKeys } = resolveSidebarProjectScope({
    groups: projectGroups,
    keys: scopeKeys,
    settings: groupingSettings,
    canClearMissingScope: snapshotsReady && configsReady,
  });
  const listed = new Set(filterSidebarV2VisibleThreads(threads, projectKeys, delegatedUnderParent));
  return needsYouDeckThreads(threads, {
    now: new Date(Math.max(Date.parse(`${nowMinute}:00.000Z`), snoozeWakeClock)).toISOString(),
    isListed: (thread) => listed.has(thread),
    honorsSnooze: (thread) => serverConfigs.has(thread.environmentId),
  });
}

/** The threads that need you, one card at a time, oldest first. */
export function TriagePage() {
  const cards = useNeedsYouDeckThreads();
  const session = useSyncExternalStore(triageDrafts.subscribe, triageDrafts.getSnapshot);
  const keys = cards.map(needsYouDeckKey);
  const [stored, setStored] = useState(EMPTY_NEEDS_YOU_DECK);
  const deck = reconcileNeedsYouDeck(stored, keys);
  if (deck !== stored) setStored(deck);
  const index = needsYouDeckIndex(deck);
  const thread = index === -1 ? null : (cards[index] ?? null);

  const step = (delta: 1 | -1) => setStored((current) => stepNeedsYouDeck(current, delta));

  return (
    <AppRouteModal
      label="Triage"
      escapeCloses={(event) => triageEscapeCloses(event, triageKeyTarget(event.target))}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex min-h-12 shrink-0 items-center gap-1 border-b ps-5 pe-2">
          <h1 className="min-w-0 truncate font-medium text-sm">Needs you</h1>
          {thread !== null ? (
            <span className="ms-1 text-muted-foreground text-sm tabular-nums">
              {index + 1} of {cards.length}
            </span>
          ) : null}
          <div className="min-w-0 flex-1" />
          {thread !== null ? (
            <>
              <DeckStepButton
                label="Previous"
                hotkey="K"
                disabled={index === 0}
                onClick={() => step(-1)}
              />
              <DeckStepButton
                label="Next"
                hotkey="J"
                disabled={index === cards.length - 1}
                onClick={() => step(1)}
              />
            </>
          ) : null}
          <AppRouteModalClose />
        </header>
        {thread === null ? (
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <InboxIcon />
              </EmptyMedia>
              <EmptyTitle>Nothing needs you</EmptyTitle>
              <EmptyDescription>
                Threads that wait for an answer, a decision or a review show up here.
              </EmptyDescription>
            </EmptyHeader>
            <DialogPrimitive.Close render={<Button variant="outline" />}>
              Close
            </DialogPrimitive.Close>
          </Empty>
        ) : (
          <TriageCard
            // Each thread gets its own card, so its reply box and page never carry over.
            key={needsYouDeckKey(thread)}
            onStep={step}
            thread={thread}
            threadRef={scopeThreadRef(thread.environmentId, thread.id)}
            draft={session.drafts[needsYouDeckKey(thread)] ?? ""}
            sending={session.sending.has(needsYouDeckKey(thread))}
            onDraftChange={(text) => triageDrafts.set(needsYouDeckKey(thread), text)}
            send={(deliver, text) => triageDrafts.send(needsYouDeckKey(thread), deliver, text)}
            sendFromPage={(deliver) => triageDrafts.sendFromPage(needsYouDeckKey(thread), deliver)}
          />
        )}
      </div>
    </AppRouteModal>
  );
}

function DeckStepButton(props: {
  readonly label: string;
  readonly hotkey: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
}) {
  const Icon = props.label === "Previous" ? ChevronLeftIcon : ChevronRightIcon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={props.label}
            size="icon-sm"
            variant="ghost"
            disabled={props.disabled}
            onClick={props.onClick}
          />
        }
      >
        <Icon />
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {props.label} <Kbd>{props.hotkey}</Kbd>
      </TooltipPopup>
    </Tooltip>
  );
}
