import { msg } from "gt-react";
import { m } from "../i18n/messages";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import { threadsNeedingYou } from "@t3tools/client-runtime/state/thread-inbox";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import type { AnyRouter } from "@tanstack/react-router";
import { parseThreadKey, threadKey } from "@t3tools/client-runtime/state/entities";
import type { EnvironmentId, NeedsYouSubject, ThreadId } from "@t3tools/contracts";
import type { ClientSettings } from "@t3tools/contracts/settings";
import * as Option from "effect/Option";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
} from "lucide-react";

import { getClientSettings, subscribeClientSettings } from "../hooks/useSettings";
import { isWindowsPlatform } from "../lib/utils";
import { needsYouSubjectsAtom } from "../state/needsYou";
import { selectVisibleLayoutTabs } from "../layout/layoutModel";
import { useLayoutStore } from "../layout/layoutStore";
import { environmentSummaries } from "../state/presentation";
import { environmentShell } from "../state/shell";
import { environmentThreadShells } from "../state/threads";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
  setNotificationBadge,
  threadNotificationTag,
  unlockNotificationAudio,
} from "../threadNotifications";
import { filterSidebarV2VisibleThreads, resolveSidebarThreadStatus } from "./Sidebar.logic";
import {
  claimedNeedsYouSubject,
  claimNeedsYouSubject,
  cursorToKeep,
  NEEDS_YOU_CLAIMS_LOCK,
  needsYouSource,
  newSubjects,
  presentationChannel,
  readNeedsYouCursor,
  shellAlerts,
  WEB_ALERT_FRESH_MS,
  writeNeedsYouCursor,
  type NeedsYouSource,
  type PresentationChannel,
  type ShellAlertsSeen,
} from "./ThreadNotificationCoordinator.logic";
import { toastManager } from "./ui/toast";

/** Threads in Needs you across every environment, which the tab title and badges show. */
export const needsYouCountAtom = Atom.make(0).pipe(
  Atom.keepAlive,
  Atom.withLabel("web-needs-you-count"),
);

const EMPTY_INPUT = {};

/** Runs `claim` while this tab alone holds the claims, so two tabs never claim the same subject. */
function withClaimsLock(claim: () => void): void {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (locks === undefined) {
    claim();
    return;
  }
  void locks.request(NEEDS_YOU_CLAIMS_LOCK, () => claim()).catch(() => undefined);
}

/** Browser storage for claims and cursors, or null where it is blocked. */
function needsYouStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

type ToastId = ReturnType<typeof toastManager.add>;

/**
 * Presents what each connected environment alerts about (its needs-you subjects) as sounds,
 * in-app toasts and system notifications, once per browser, and keeps the tab title, favicon and
 * dock badge at the number of threads that need the user.
 */
export function startThreadNotifications(
  registry: AtomRegistry.AtomRegistry,
  router: AnyRouter,
): () => void {
  const pending = new Map<
    string,
    { environmentId: EnvironmentId; threadId: ThreadId; notification: Notification }
  >();
  const watched = new Map<
    EnvironmentId,
    { readonly unsubscribe: () => void; readonly retry: () => void }
  >();

  // Toasts by thread key, so hiding or opening a thread, or removing its environment, closes them.
  const openToasts = new Map<string, Array<{ readonly id: ToastId; readonly tag: string }>>();
  const forgetToast = (key: string, toastId: ToastId) => {
    const remaining = (openToasts.get(key) ?? []).filter((toast) => toast.id !== toastId);
    if (remaining.length === 0) openToasts.delete(key);
    else openToasts.set(key, remaining);
  };
  const closeToasts = (shouldClose: (key: string) => boolean) => {
    for (const [key, toasts] of openToasts) {
      if (!shouldClose(key)) continue;
      for (const toast of toasts) toastManager.close(toast.id);
      openToasts.delete(key);
    }
  };
  const activeThread = () =>
    (router.state.matches.at(-1)?.params ?? {}) as {
      environmentId?: EnvironmentId;
      threadId?: ThreadId;
      draftId?: string;
    };
  /** A pane shows the thread, also one the route does not name. */
  const threadShown = (environmentId: EnvironmentId, threadId: ThreadId) => {
    const active = activeThread();
    if (active.environmentId === environmentId && active.threadId === threadId) return true;
    return (
      (active.threadId !== undefined || active.draftId !== undefined) &&
      selectVisibleLayoutTabs(useLayoutStore.getState().layout).some(
        (tab) =>
          tab.content.kind === "chat" &&
          tab.content.target.kind === "server" &&
          tab.content.target.threadRef.environmentId === environmentId &&
          tab.content.target.threadRef.threadId === threadId,
      )
    );
  };
  const closeOpenedThreadToasts = () => {
    const { environmentId, threadId } = activeThread();
    if (environmentId === undefined || threadId === undefined) return;
    const opened = threadKey({ environmentId, threadId });
    closeToasts((key) => key === opened);
  };
  // A notification shown before the tag filter turned on must not stay on screen. While hiding,
  // one whose thread left the live list (archived) cannot be judged, so it closes too.
  const closeHiddenPending = () => {
    const hidden = registry.get(environmentThreadShells.hiddenThreadKeysAtom);
    const live = registry.get(environmentThreadShells.anyEnvironmentHidingAtom)
      ? new Set(registry.get(environmentThreadShells.threadRefsAtom).map(threadKey))
      : null;
    const shouldClose = (key: string) => hidden.has(key) || (live !== null && !live.has(key));
    closeToasts(shouldClose);
    for (const [tag, entry] of pending) {
      if (!shouldClose(threadKey(entry))) continue;
      entry.notification.close();
      pending.delete(tag);
    }
  };
  const clearPending = () => {
    for (const { notification } of pending.values()) notification.close();
    pending.clear();
  };
  /** A resolved subject takes its notification and toast with it. */
  const closeTag = (tag: string) => {
    pending.get(tag)?.notification.close();
    pending.delete(tag);
    for (const toasts of openToasts.values()) {
      for (const toast of toasts) if (toast.tag === tag) toastManager.close(toast.id);
    }
  };

  const tabState = () => {
    const { notificationMode: mode, inAppNotificationsEnabled } = getClientSettings();
    return {
      system:
        hasDesktopNotifications(mode) &&
        typeof Notification !== "undefined" &&
        Notification.permission === "granted",
      sound: hasNotificationSound(mode),
      focused: document.visibilityState === "visible" && document.hasFocus(),
      toasts: inAppNotificationsEnabled,
    };
  };

  const subjectTag = (environmentId: EnvironmentId, subject: NeedsYouSubject) =>
    subject.source === "digest"
      ? "t3-needs-you-digest"
      : threadNotificationTag(
          environmentId,
          `${subject.threadId}/${subject.replaces ?? subject.id}`,
        );

  /**
   * The thread a subject is about as this tab shows it, null when it should not present, or
   * "waiting" while this tab's shell does not show it: the thread is not loaded, or an ask is not
   * open in it, until it opens or the stream resolves it.
   */
  const presentableThread = (environmentId: EnvironmentId, subject: NeedsYouSubject) => {
    const shell = registry.get(environmentShell.stateValueAtom(environmentId));
    const raw = Option.isSome(shell.snapshot)
      ? shell.snapshot.value.threads.find((thread) => thread.id === subject.threadId)
      : undefined;
    if (raw === undefined) return "waiting" as const;
    const subagentRequest =
      registry
        .get(environmentThreadShells.pendingSubagentRequestsAtom(environmentId))
        .get(raw.id) ?? null;
    const thread = presentThreadShell(environmentId, raw, subagentRequest);
    const key = threadKey({ environmentId, threadId: thread.id });
    // As on the server: a failure after the snooze began wakes the thread for its own alert,
    // also once a later run, such as a queued wake, is the latest.
    const failureWoke =
      subject.source === "run" &&
      subject.kind === "failed" &&
      (thread.snoozedAt === null || Date.parse(subject.at) > Date.parse(thread.snoozedAt));
    if (
      thread.archivedAt !== null ||
      registry.get(environmentThreadShells.hiddenThreadKeysAtom).has(key) ||
      (subject.source !== "digest" &&
        !failureWoke &&
        effectiveSnoozed(thread, { now: new Date().toISOString() }))
    ) {
      return null;
    }
    // The shell can show an answer before the stream resolves the ask.
    const askId = subject.id.startsWith("remind:") ? subject.id.slice(7) : subject.id;
    if (askId.startsWith("ask:") && !thread.openAsks?.some((ask) => `ask:${ask.id}` === askId)) {
      return "waiting" as const;
    }
    let status = resolveSidebarThreadStatus(thread);
    if (status === "ready" && thread.latestRun?.status === "failed") status = "failed";
    return { thread, status };
  };

  /** Presents the subject through the channel; false when the browser rejected it. */
  const present = (
    environmentId: EnvironmentId,
    subject: NeedsYouSubject,
    target: Exclude<ReturnType<typeof presentableThread>, null | "waiting">,
    channel: PresentationChannel,
    quiet: boolean,
  ): boolean => {
    const { thread, status } = target;
    const completion = subject.source === "run" && subject.kind === "completed";
    const title =
      subject.source === "digest"
        ? (subject.text ?? m(msg("Threads need you")))
        : subject.source === "reminder"
          ? m(msg("Still waiting for you"))
          : completion
            ? m(msg("Thread completed"))
            : subject.source === "run"
              ? status === "limited"
                ? m(msg("Usage limit reached"))
                : m(msg("Thread failed"))
              : subject.source === "guest"
                ? m(msg("Guest request"))
                : subject.kind === "approval"
                  ? m(msg("Approval needed"))
                  : m(msg("Input needed"));
    const body =
      subject.source === "digest"
        ? m(msg("Waiting longest: {title}", { title: thread.title }))
        : subject.source === "reminder"
          ? `${thread.title}: ${subject.text ?? ""}`
          : thread.title;
    const tag = subjectTag(environmentId, subject);
    const open = () =>
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: thread.id },
      });
    const sound = () => {
      if (!tabState().sound || quiet) return;
      void playNotificationSound(completion ? "completion" : "input", () =>
        hasNotificationSound(getClientSettings().notificationMode),
      );
    };
    if (channel === "toast") {
      const toastKey = threadKey({ environmentId, threadId: thread.id });
      // Like a notification's tag, a newer toast takes the place of the one it replaces.
      for (const toast of openToasts.get(toastKey) ?? []) {
        if (toast.tag === tag) toastManager.close(toast.id);
      }
      const toastId: ToastId = toastManager.add({
        onRemove: (): void => forgetToast(toastKey, toastId),
        type: completion ? "success" : status === "failed" ? "error" : "warning",
        title,
        description: body,
        data: {
          hideCopyButton: true,
          leadingIcon: completion ? (
            <CircleCheckIcon aria-hidden className="size-4 text-success-foreground" />
          ) : subject.kind === "approval" ? (
            <ShieldQuestionIcon aria-hidden className="size-4 text-warning-foreground" />
          ) : status === "limited" && subject.source === "run" ? (
            <CircleAlertIcon aria-hidden className="size-4 text-warning-foreground" />
          ) : subject.source === "run" ? (
            <CircleAlertIcon aria-hidden className="size-4 text-destructive-foreground" />
          ) : (
            <MessageCircleQuestionIcon aria-hidden className="size-4 text-info-foreground" />
          ),
        },
        actionProps: {
          children: m(msg("Open thread")),
          onClick: () => {
            toastManager.close(toastId);
            open();
          },
        },
      });
      openToasts.set(toastKey, [...(openToasts.get(toastKey) ?? []), { id: toastId, tag }]);
      sound();
      return true;
    }
    if (channel !== "system") {
      sound();
      return true;
    }
    try {
      const notification = new Notification(title, {
        body,
        tag,
        silent: true,
        // Windows drops clicks after a toast moves into Notification Center.
        requireInteraction: completion && isWindowsPlatform(navigator.platform),
      });
      pending.get(tag)?.notification.close();
      pending.set(tag, { environmentId, threadId: thread.id, notification });
      notification.addEventListener("click", () => {
        notification.close();
        window.focus();
        void window.desktopBridge?.revealWindow().catch(() => undefined);
        open();
      });
    } catch {
      // Some browsers expose Notification but reject desktop presentation.
      return false;
    }
    sound();
    return true;
  };

  /**
   * Presents subjects, each once per browser by a tab that can. One this tab cannot present now
   * waits in `deferred` for its focus or its thread, unless another tab presents it first. The
   * subjects are read under the claims lock, and `done` runs there after them.
   */
  const presentSubjects = (
    environmentId: EnvironmentId,
    subjects: () => ReadonlyArray<NeedsYouSubject>,
    watch: {
      readonly deferred: Map<string, NeedsYouSubject>;
      /** Each subject's highest version the snapshots brought while presentations are queued. */
      readonly newest: ReadonlyMap<string, number>;
    },
    done: () => void,
  ) => {
    const { deferred, newest } = watch;
    withClaimsLock(() => {
      const storage = needsYouStorage();
      const nowMs = Date.now();
      for (const subject of subjects()) {
        // A newer version, such as its resolution, waits behind this lock and decides it.
        if (subject.version < (newest.get(subject.id) ?? 0)) continue;
        deferred.delete(subject.id);
        if (subject.resolved) {
          closeTag(subjectTag(environmentId, subject));
          continue;
        }
        // Its ask takes its place: shown with a sound where this completion was not shown.
        if (subject.superseded) continue;
        if (Date.parse(subject.publishedAt) < nowMs - WEB_ALERT_FRESH_MS) continue;
        if (claimedNeedsYouSubject(storage, environmentId, subject.id, nowMs)) continue;
        const target = presentableThread(environmentId, subject);
        if (target === "waiting") {
          deferred.set(subject.id, subject);
          continue;
        }
        if (target === null) continue;
        const tab = {
          ...tabState(),
          scheduled: subject.source === "reminder" || subject.source === "digest",
          viewing: threadShown(environmentId, subject.threadId),
        };
        const channel = presentationChannel(tab);
        if (channel === null) {
          deferred.set(subject.id, subject);
          continue;
        }
        // An ask that replaces its run's completion is quiet where that completion was presented.
        const quiet =
          subject.replaces !== undefined &&
          claimedNeedsYouSubject(storage, environmentId, subject.replaces, nowMs);
        // A browser can refuse a system notification it allows. A focused tab then uses its other
        // channels; a background one waits to be focused.
        const fallback =
          channel === "system" && tab.focused
            ? presentationChannel({ ...tab, system: false })
            : null;
        // Claimed only once presented, so another tab, or this one later, can present it instead.
        if (
          !present(environmentId, subject, target, channel, quiet) &&
          (fallback === null || !present(environmentId, subject, target, fallback, quiet))
        ) {
          deferred.set(subject.id, subject);
          continue;
        }
        claimNeedsYouSubject(storage, environmentId, subject.id, nowMs);
      }
      done();
    });
  };

  /**
   * Alerts from the environment's shells, on a server built before the needs-you stream, as before
   * it: a thread starting to need the user, and a failed run. No reminders and no digest.
   */
  const watchShellAlerts = (environmentId: EnvironmentId) => {
    let seen: ShellAlertsSeen | null = null;
    let open: ReadonlySet<string> = new Set();
    const watch = {
      deferred: new Map<string, NeedsYouSubject>(),
      newest: new Map<string, number>(),
    };
    const observe = () => {
      const shell = registry.get(environmentShell.stateValueAtom(environmentId));
      if (shell.status !== "live" || Option.isNone(shell.snapshot)) return;
      const requests = registry.get(
        environmentThreadShells.pendingSubagentRequestsAtom(environmentId),
      );
      const threads = filterSidebarV2VisibleThreads(
        shell.snapshot.value.threads.map((raw) =>
          presentThreadShell(environmentId, raw, requests.get(raw.id) ?? null),
        ),
        null,
        registry.get(environmentThreadShells.delegatedUnderParentAtom),
      );
      const next = shellAlerts(seen, threads, new Date().toISOString());
      seen = next.seen;
      open = next.open;
      // A need that ended before this tab could present it presents nothing, also one that ends
      // while its presentation waits for the claims lock.
      for (const id of watch.deferred.keys()) if (!open.has(id)) watch.deferred.delete(id);
      const waiting = [...watch.deferred.values()];
      if (next.alerts.length === 0 && waiting.length === 0) return;
      presentSubjects(
        environmentId,
        () => [...next.alerts, ...waiting].filter((subject) => open.has(subject.id)),
        watch,
        () => {},
      );
    };
    const unsubscribe = [
      registry.subscribe(environmentShell.stateValueAtom(environmentId), observe, {
        immediate: true,
      }),
      registry.subscribe(
        environmentThreadShells.pendingSubagentRequestsAtom(environmentId),
        observe,
      ),
    ];
    return {
      unsubscribe: () => {
        for (const stop of unsubscribe) stop();
      },
      retry: observe,
    };
  };

  const watchEnvironment = (environmentId: EnvironmentId) => {
    // The newest version the snapshots brought; their subjects may still wait for the claims lock.
    let cursor = readNeedsYouCursor(needsYouStorage(), environmentId);
    // Moved under the claims lock once every subject through it was presented, passed over, or
    // put in `deferred`.
    let accounted = cursor;
    // A later snapshot can leave out a subject, such as an ask that opened again after its
    // resolution, while a presentation of its older version still waits for the claims lock.
    const newest = new Map<string, number>();
    let queued = 0;
    const deferred = new Map<string, NeedsYouSubject>();
    const watch = { deferred, newest };
    // Under the claims lock. A reload starts before what still waits here.
    const saveCursor = (through: number | null) => {
      if (through !== null) accounted = Math.max(accounted ?? through, through);
      if (accounted !== null) {
        writeNeedsYouCursor(
          needsYouStorage(),
          environmentId,
          cursorToKeep(accounted, deferred.values()),
        );
      }
    };
    const queuePresentation = (
      subjects: () => ReadonlyArray<NeedsYouSubject>,
      through: number | null,
    ) => {
      queued += 1;
      presentSubjects(environmentId, subjects, watch, () => {
        saveCursor(through);
        queued -= 1;
        // Nothing queued compares against these now, and a deferred subject is its newest version.
        if (queued === 0) newest.clear();
      });
    };
    const retry = () => {
      if (deferred.size > 0) queuePresentation(() => [...deferred.values()], null);
    };
    // Presenting reads the environment's threads, so they stay loaded while it is watched.
    const shellAtom = environmentShell.stateValueAtom(environmentId);
    const unmountShell = registry.mount(shellAtom);
    // A subject can arrive before its thread does.
    const unsubscribeShell = registry.subscribe(shellAtom, retry);
    let source: NeedsYouSource | null = null;
    let shellAlertsWatch: ReturnType<typeof watchShellAlerts> | null = null;
    const unsubscribeSubjects = registry.subscribe(
      needsYouSubjectsAtom({ environmentId, input: EMPTY_INPUT }),
      (result) => {
        source = needsYouSource(source, result);
        if (source === "shells") shellAlertsWatch ??= watchShellAlerts(environmentId);
        if (source !== "stream" || !AsyncResult.isSuccess(result)) return;
        const listed = new Set<string>();
        for (const { id, version } of result.value.subjects) {
          listed.add(id);
          newest.set(id, Math.max(newest.get(id) ?? 0, version));
        }
        // A waiting subject the server stopped listing presents nothing, such as an ask answered
        // and cancelled in one go, which the server dropped.
        for (const id of deferred.keys()) if (!listed.has(id)) deferred.delete(id);
        const next = newSubjects(result.value.subjects, cursor);
        cursor = next.cursor;
        queuePresentation(() => next.subjects, next.cursor);
      },
      { immediate: true },
    );
    return {
      unsubscribe: () => {
        unsubscribeSubjects();
        shellAlertsWatch?.unsubscribe();
        unsubscribeShell();
        unmountShell();
      },
      retry: () => {
        retry();
        shellAlertsWatch?.retry();
      },
    };
  };
  const retryDeferred = () => {
    for (const { retry } of watched.values()) retry();
  };
  window.addEventListener("focus", retryDeferred);
  document.addEventListener("visibilitychange", retryDeferred);

  const syncEnvironments = () => {
    const { notificationMode, inAppNotificationsEnabled } = getClientSettings();
    const enabled = notificationMode !== "off" || inAppNotificationsEnabled;
    if (!enabled) closeToasts(() => true);
    const environmentIds = enabled ? registry.get(environmentSummaries.environmentIdsAtom) : [];
    const activeIds = new Set(environmentIds);
    for (const [environmentId, { unsubscribe }] of watched) {
      if (activeIds.has(environmentId)) continue;
      unsubscribe();
      watched.delete(environmentId);
    }
    for (const environmentId of environmentIds) {
      if (!watched.has(environmentId)) watched.set(environmentId, watchEnvironment(environmentId));
    }
  };

  const pruneRemovedEnvironments = () => {
    const activeIds = new Set(registry.get(environmentSummaries.environmentIdsAtom));
    closeToasts((key) => !activeIds.has(parseThreadKey(key).environmentId));
    for (const [tag, entry] of pending) {
      if (activeIds.has(entry.environmentId)) continue;
      entry.notification.close();
      pending.delete(tag);
    }
  };

  // Listeners that only exist for some notification modes, rebuilt when the mode changes.
  let appliedMode: ClientSettings["notificationMode"] | null = null;
  let stopModeListeners = () => {};
  const applyMode = () => {
    const nextMode = getClientSettings().notificationMode;
    if (nextMode === appliedMode) return;
    appliedMode = nextMode;
    stopModeListeners();
    clearPending();
    const stops: Array<() => void> = [];
    if (hasDesktopNotifications(nextMode)) {
      window.addEventListener("focus", clearPending);
      stops.push(() => {
        window.removeEventListener("focus", clearPending);
        clearPending();
      });
    }
    if (hasNotificationSound(nextMode)) {
      // Electron's default autoplay policy needs no gesture, unlike browsers.
      if (window.desktopBridge) unlockNotificationAudio();
      document.addEventListener("pointerdown", unlockNotificationAudio);
      document.addEventListener("keydown", unlockNotificationAudio);
      stops.push(() => {
        document.removeEventListener("pointerdown", unlockNotificationAudio);
        document.removeEventListener("keydown", unlockNotificationAudio);
      });
    }
    stopModeListeners = () => {
      for (const stop of stops) stop();
    };
  };

  // The count is state, not unread notifications: it stays until the threads are answered.
  let shownCount: number | null = null;
  const updateNeedsYou = () => {
    const count = threadsNeedingYou(
      filterSidebarV2VisibleThreads(
        registry.get(environmentThreadShells.quietThreadShellsAtom),
        null,
        registry.get(environmentThreadShells.delegatedUnderParentAtom),
      ),
      { now: new Date().toISOString() },
    ).length;
    if (count === shownCount) return;
    shownCount = count;
    registry.set(needsYouCountAtom, count);
    setNotificationBadge(count);
  };
  const unsubscribeNeedsYou = [
    registry.subscribe(environmentThreadShells.quietThreadShellsAtom, updateNeedsYou, {
      immediate: true,
    }),
    registry.subscribe(environmentThreadShells.delegatedUnderParentAtom, updateNeedsYou),
  ];
  // Snoozes end without a shell change.
  const countInterval = setInterval(updateNeedsYou, 60_000);

  const onSettings = () => {
    applyMode();
    syncEnvironments();
  };
  const unsubscribeSettings = subscribeClientSettings(onSettings);
  const unsubscribeEnvironmentIds = registry.subscribe(
    environmentSummaries.environmentIdsAtom,
    () => {
      pruneRemovedEnvironments();
      syncEnvironments();
    },
  );
  const unsubscribeHidden = [
    registry.subscribe(environmentThreadShells.hiddenThreadKeysAtom, closeHiddenPending),
    registry.subscribe(environmentThreadShells.anyEnvironmentHidingAtom, closeHiddenPending),
    registry.subscribe(environmentThreadShells.threadRefsAtom, closeHiddenPending),
  ];
  const unsubscribeRoute = router.subscribe("onResolved", closeOpenedThreadToasts);
  onSettings();

  return () => {
    unsubscribeSettings();
    unsubscribeEnvironmentIds();
    for (const unsubscribe of unsubscribeHidden) unsubscribe();
    unsubscribeRoute();
    for (const unsubscribe of unsubscribeNeedsYou) unsubscribe();
    clearInterval(countInterval);
    window.removeEventListener("focus", retryDeferred);
    document.removeEventListener("visibilitychange", retryDeferred);
    for (const { unsubscribe } of watched.values()) unsubscribe();
    watched.clear();
    stopModeListeners();
    closeToasts(() => true);
  };
}
