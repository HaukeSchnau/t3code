import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
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
import { T, useGT, Var } from "gt-react";

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
  loaded: () => durableCommandOutbox().loaded(),
  holdsThread: (key) =>
    durableCommandOutbox()
      .entries()
      .some((entry) => scopedThreadKey(entry.command) === key),
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
  const gt = useGT();
  const cards = useNeedsYouDeckThreads();
  const session = useSyncExternalStore(triageDrafts.subscribe, triageDrafts.getSnapshot);
  const keys = cards.map(needsYouDeckKey);
  const [stored, setStored] = useState(EMPTY_NEEDS_YOU_DECK);
  const deck = reconcileNeedsYouDeck(stored, keys);
  if (deck !== stored) setStored(deck);
  const index = needsYouDeckIndex(deck);
  const thread = index === -1 ? null : (cards[index] ?? null);
  const sending = useSyncExternalStore(
    triageDrafts.subscribe,
    () => thread !== null && triageDrafts.sending(needsYouDeckKey(thread)),
  );

  const step = (delta: 1 | -1) => setStored((current) => stepNeedsYouDeck(current, delta));

  return (
    <AppRouteModal
      label={gt("Triage", { $context: "noun, the screen that goes through threads that need you" })}
      escapeCloses={(event) => triageEscapeCloses(event, triageKeyTarget(event.target))}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex min-h-12 shrink-0 items-center gap-1 border-b ps-5 pe-2">
          <h1 className="min-w-0 truncate font-medium text-sm">
            <T>Needs you</T>
          </h1>
          {thread !== null ? (
            <span className="ms-1 text-muted-foreground text-sm tabular-nums">
              <T>
                <Var>{index + 1}</Var> of <Var>{cards.length}</Var>
              </T>
            </span>
          ) : null}
          <div className="min-w-0 flex-1" />
          {thread !== null ? (
            <>
              <DeckStepButton
                direction="previous"
                label={gt("Previous")}
                hotkey="K"
                disabled={index === 0}
                onClick={() => step(-1)}
              />
              <DeckStepButton
                direction="next"
                label={gt("Next")}
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
              <EmptyTitle>
                <T>Nothing needs you</T>
              </EmptyTitle>
              <EmptyDescription>
                <T>Threads that wait for an answer, a decision or a review show up here.</T>
              </EmptyDescription>
            </EmptyHeader>
            <DialogPrimitive.Close render={<Button variant="outline" />}>
              <T>Close</T>
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
            sending={sending}
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
  readonly direction: "previous" | "next";
  readonly label: string;
  readonly hotkey: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
}) {
  const Icon = props.direction === "previous" ? ChevronLeftIcon : ChevronRightIcon;
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
