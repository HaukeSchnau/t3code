import { useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation } from "@react-navigation/native";
import {
  EMPTY_NEEDS_YOU_DECK,
  needsYouAnswers,
  needsYouCard,
  needsYouDeckIndex,
  needsYouDeckKey,
  needsYouPageFrame,
  reconcileNeedsYouDeck,
  stepNeedsYouDeck,
  TRIAGE_SNOOZE_MS,
} from "@t3tools/client-runtime/state/needs-you-triage";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { threadNeedLabel } from "@t3tools/client-runtime/state/thread-inbox";
import { derivePendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import { canSnooze } from "@t3tools/client-runtime/state/thread-settled";
import * as Option from "effect/Option";
import { T, useGT, useMessages, Var } from "gt-react-native";
import { useEffectEvent, useState, useSyncExternalStore } from "react";
import { Pressable, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useResolveClassNames } from "uniwind";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useBarOverlap } from "../../components/ui/useBarInset";
import { useNowMinuteMs } from "../../lib/clock";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useNavigationThreadShells, useProject, useProjects } from "../../state/entities";
import { threadListEnvironmentsAtom } from "../../state/presentation";
import { htmlRenderEnvironment } from "../../state/htmlRender";
import { useEnvironmentQuery } from "../../state/query";
import { threadEnvironment, useEnvironmentThread } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { relativeTime } from "../../lib/time";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import { useHomeListOptions } from "../home/home-list-options";
import { useThreadListActions } from "../home/useThreadListActions";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { ThreadHtmlRender } from "../threads/HtmlRenderWebView";
import { useThreadListNow } from "../threads/use-thread-list-now";
import { useWorldFiling } from "../home/worldFiling";
import { triageDeckThreads, triagePageView, type TriagePageView } from "./triageDeck";
import { queueTriageMessage, triageDrafts } from "./triageSession";

const SWIPE_DISTANCE = 80;
const SWIPE_VELOCITY = 600;

/** The thread list's Needs you section, under the list's filters. */
function useNeedsYouDeckThreads() {
  const threads = useNavigationThreadShells();
  const projects = useProjects();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const { options } = useHomeListOptions(
    new Set(Object.values(savedConnectionsById).map((connection) => connection.environmentId)),
  );
  const { settlementEnvironmentIds, snoozeEnvironmentIds } = useAtomValue(
    threadListEnvironmentsAtom,
  );
  const now = useThreadListNow(threads);
  const worldFiling = useWorldFiling();
  return triageDeckThreads({
    threads,
    projects,
    options,
    settlementEnvironmentIds,
    snoozeEnvironmentIds,
    now,
    worldFiling,
  });
}

/** The threads that need you, one card at a time, oldest first. Swipe to move between them. */
export function TriageScreen() {
  const gt = useGT();
  const navigation = useNavigation();
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
    <SettingsScreen title={gt("Needs you")}>
      {thread === null ? (
        <View className="flex-1 justify-center px-5">
          <EmptyState
            variant="plain"
            title={gt("Nothing needs you")}
            detail={gt("Threads that wait for an answer, a decision or a review show up here.")}
            actionLabel={gt("Close")}
            onAction={() => navigation.goBack()}
          />
        </View>
      ) : (
        <TriageCard
          key={needsYouDeckKey(thread)}
          thread={thread}
          position={{ index, total: cards.length }}
          draft={session.drafts[needsYouDeckKey(thread)] ?? ""}
          sending={sending}
          onDraftChange={(text) => triageDrafts.set(needsYouDeckKey(thread), text)}
          send={(deliver, text) => triageDrafts.send(needsYouDeckKey(thread), deliver, text)}
          onStep={step}
        />
      )}
    </SettingsScreen>
  );
}

function TriageCard(props: {
  readonly thread: EnvironmentThreadShell;
  readonly position: { readonly index: number; readonly total: number };
  readonly draft: string;
  /** The thread's reply or answer is on its way, also one from before triage or the app closed. */
  readonly sending: boolean;
  readonly onDraftChange: (text: string) => void;
  /** Sends unless one is on its way; a send that went out with `text` clears that draft. */
  readonly send: (deliver: () => Promise<boolean>, text?: string) => Promise<boolean>;
  readonly onStep: (delta: 1 | -1) => void;
}) {
  const { thread, sending } = props;
  const gt = useGT();
  const messages = useMessages();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  // The card's controls sit outside the scroll view, so the body clears the iOS bar itself.
  const barOverlap = useBarOverlap();
  const nowMs = useNowMinuteMs();
  const { color: iconColor } = useResolveClassNames("text-icon-subtle");
  const markdownStyles = useMarkdownPreviewStyles();
  const project = useProject({ environmentId: thread.environmentId, projectId: thread.projectId });
  const detail = Option.getOrNull(useEnvironmentThread(thread.environmentId, thread.id).data);
  const connected = useWorkspaceEnvironments().some(
    (environment) =>
      environment.environmentId === thread.environmentId &&
      environment.connectionState === "connected",
  );
  const { snoozeThread, dismissThreadAsks } = useThreadListActions();
  const respondToUserInput = useAtomCommand(
    threadEnvironment.respondToUserInput,
    "thread user input response",
  );
  const [storedPageView, setPageView] = useState<TriagePageView>({
    renderId: null,
    selected: undefined,
    heights: new Map(),
  });
  const [frameWidth, setFrameWidth] = useState(0);

  const card = needsYouCard({
    thread,
    rows: detail?.visibleTurnItems ?? [],
    requests: detail === null ? null : derivePendingThreadRequests(detail),
  });
  const { need, latest, page, question, waitingOn, replyMode, answersHere } = card;
  const pageView = triagePageView(storedPageView, page?.renderId ?? null);
  if (pageView !== storedPageView) setPageView(pageView);
  // A page further back than the loaded timeline comes from the thread's page index.
  const indexedPages = useEnvironmentQuery(
    page !== null && page.versions === null
      ? htmlRenderEnvironment.pages({
          environmentId: thread.environmentId,
          input: { threadId: thread.id, renderId: page.renderId, filter: "all", limit: 1 },
        })
      : null,
  );
  const pageFrame =
    page === null ? null : needsYouPageFrame(page, indexedPages.data?.pages ?? null);
  const snoozable = canSnooze(thread, { now: new Date(nowMs).toISOString() });

  const answer = async (reply: Parameters<typeof needsYouAnswers>[1]) => {
    const answers = question === null ? null : needsYouAnswers(question, reply);
    if (question === null || answers === null) return false;
    const result = await respondToUserInput({
      environmentId: thread.environmentId,
      input: { threadId: thread.id, requestId: question.requestId, answers },
    });
    return result._tag === "Success";
  };

  const submitReply = () => {
    const draft = props.draft;
    if (sending || draft.trim().length === 0 || replyMode === null) return;
    void props.send(
      () =>
        replyMode === "answer"
          ? answer({ text: draft })
          : queueTriageMessage(
              { environmentId: thread.environmentId, threadId: thread.id },
              draft.trim(),
            ).catch(() => false),
      draft,
    );
  };

  const pickOption = (option: string) => {
    if (!sending) void props.send(() => answer({ option }));
  };

  // Pushed on Android too, so Back from the thread returns to the deck.
  const openThread = () =>
    navigation.dispatch(
      StackActions.push("Thread", {
        environmentId: String(thread.environmentId),
        threadId: String(thread.id),
      }),
    );

  const handleSwipe = useEffectEvent((delta: 1 | -1) => props.onStep(delta));
  const translateX = useSharedValue(0);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ translateX: translateX.value }] }));
  const [swipe] = useState(() =>
    Gesture.Pan()
      .activeOffsetX([-24, 24])
      .failOffsetY([-14, 14])
      .onUpdate((event) => {
        translateX.value = event.translationX * 0.6;
      })
      .onEnd((event, success) => {
        const delta = !success
          ? 0
          : event.translationX < -SWIPE_DISTANCE || event.velocityX < -SWIPE_VELOCITY
            ? 1
            : event.translationX > SWIPE_DISTANCE || event.velocityX > SWIPE_VELOCITY
              ? -1
              : 0;
        translateX.value = withTiming(0, { duration: 160 });
        if (delta !== 0) runOnJS(handleSwipe)(delta);
      }),
  );

  if (need === null) return null;
  const waited = need.since === null ? null : relativeTime(need.since, nowMs);

  return (
    <GestureDetector gesture={swipe}>
      <Animated.View style={[{ flex: 1, paddingTop: barOverlap }, animatedStyle]}>
        <KeyboardAvoidingView automaticOffset behavior="padding" className="flex-1">
          <ScrollView
            className="flex-1"
            contentContainerClassName="gap-4 px-5 pb-6 pt-3"
            keyboardShouldPersistTaps="handled"
            onLayout={(event) => setFrameWidth(event.nativeEvent.layout.width - 40)}
          >
            <View className="flex-row items-center gap-2">
              <Text className="min-w-0 flex-1 text-xs text-foreground-tertiary" numberOfLines={1}>
                {project?.isScratch ? gt("No project") : (project?.title ?? gt("Project"))}
                {" · "}
                {threadNeedLabel({ ...need, text: null }, messages)}
                {waited === null ? null : ` · ${gt("waiting {time}", { time: waited })}`}
              </Text>
              <DeckStep
                symbol="chevron.left"
                label={gt("Previous thread")}
                disabled={props.position.index === 0}
                onPress={() => props.onStep(-1)}
              />
              <Text className="text-xs text-foreground-secondary">
                <T>
                  <Var>{props.position.index + 1}</Var> of <Var>{props.position.total}</Var>
                </T>
              </Text>
              <DeckStep
                symbol="chevron.right"
                label={gt("Next thread")}
                disabled={props.position.index === props.position.total - 1}
                onPress={() => props.onStep(1)}
              />
            </View>
            <Text className="text-lg font-t3-bold text-foreground">{thread.title}</Text>
            {need.text !== null ? (
              <View className="rounded-2xl border border-border bg-card px-4 py-3">
                <Text className="text-base font-t3-medium text-foreground">{need.text}</Text>
              </View>
            ) : null}
            {page !== null ? (
              pageFrame !== null && frameWidth > 0 ? (
                <ThreadHtmlRender
                  // The page's render id: the thread's next page starts without this one's load state.
                  key={page.renderId}
                  environmentId={thread.environmentId}
                  threadId={thread.id}
                  render={pageFrame.render}
                  versions={pageFrame.versions}
                  selected={pageView.selected}
                  onSelect={(selected) => setPageView((view) => ({ ...view, selected }))}
                  contentHeight={pageView.heights.get(
                    pageFrame.versions[pageView.selected ?? pageFrame.versions.length - 1]
                      ?.htmlRender.attachmentId ?? "",
                  )}
                  onContentHeight={(attachmentId, height) =>
                    setPageView((view) => ({
                      ...view,
                      heights: new Map(view.heights).set(attachmentId, height),
                    }))
                  }
                  onFocusRect={() => undefined}
                  frameWidth={frameWidth}
                  iconColor={iconColor ?? "gray"}
                  triage
                />
              ) : pageFrame === null &&
                detail !== null &&
                (indexedPages.isSuccess || indexedPages.error !== null) ? (
                <Text className="text-sm text-foreground-secondary">
                  <T>The page is further back in the thread. Open the thread to see it.</T>
                </Text>
              ) : null
            ) : null}
            {question !== null ? (
              <View className="gap-2">
                <Text className="text-sm font-t3-medium text-foreground">{question.question}</Text>
                {question.options.map((option) => (
                  <Pressable
                    key={option.value ?? option.label}
                    accessibilityRole="button"
                    accessibilityLabel={gt("Answer {option}", { option: option.label })}
                    disabled={sending}
                    className="rounded-2xl border border-border bg-card px-4 py-3"
                    style={({ pressed }) => ({ opacity: pressed || sending ? 0.6 : 1 })}
                    onPress={() => pickOption(option.value ?? option.label)}
                  >
                    <Text className="text-base font-t3-medium text-foreground">{option.label}</Text>
                    <Text className="text-xs text-foreground-secondary">{option.description}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            {waitingOn.length > 0 ? (
              <View className="gap-1.5 rounded-2xl border border-border bg-card px-4 py-3">
                {waitingOn.map((text) => (
                  <Text key={text} className="text-sm font-t3-medium text-foreground">
                    {text}
                  </Text>
                ))}
              </View>
            ) : null}
            <View className="gap-2">
              <Text className="text-xs text-foreground-tertiary">
                <T>Last message</T>
              </Text>
              {latest !== null ? (
                <View className="rounded-2xl border border-border px-4 py-2">
                  <SelectableMarkdownText
                    markdown={latest.text}
                    textStyle={markdownStyles.nativeTextStyle}
                  />
                </View>
              ) : (
                <Text className="text-sm text-foreground-secondary">
                  {detail !== null
                    ? gt("The agent has not written yet.")
                    : connected
                      ? gt("Loading")
                      : gt("Its environment is not connected.")}
                </Text>
              )}
            </View>
          </ScrollView>
          <View
            className="gap-2 border-t border-border px-5 pt-3"
            style={{ paddingBottom: Math.max(insets.bottom, 12) }}
          >
            {replyMode !== null ? (
              <View className="flex-row items-end gap-2">
                <TextInput
                  accessibilityLabel={replyMode === "answer" ? gt("Your answer") : gt("Reply")}
                  className="max-h-32 flex-1"
                  multiline
                  placeholder={
                    replyMode === "answer" ? gt("Or type your answer") : gt("Reply to the agent")
                  }
                  value={props.draft}
                  onChangeText={props.onDraftChange}
                />
                <Button
                  label={gt("Send")}
                  icon="arrow.up"
                  tone="primary"
                  size="compact"
                  disabled={sending || props.draft.trim().length === 0}
                  loading={sending}
                  onPress={submitReply}
                />
              </View>
            ) : null}
            <View className="flex-row flex-wrap gap-2">
              <Button
                label={answersHere ? gt("Open thread") : gt("Open thread to answer")}
                icon="arrow.up.right"
                tone={answersHere ? "secondary" : "primary"}
                size="compact"
                onPress={openThread}
              />
              <Button
                label={gt("Snooze 1 h")}
                icon="clock"
                size="compact"
                disabled={!snoozable}
                onPress={() =>
                  void snoozeThread(thread, new Date(Date.now() + TRIAGE_SNOOZE_MS).toISOString())
                }
              />
              {card.hasOpenAsks ? (
                <Button
                  label={gt("No reply needed")}
                  icon="checkmark.bubble"
                  size="compact"
                  onPress={() => void dismissThreadAsks(thread)}
                />
              ) : null}
            </View>
          </View>
        </KeyboardAvoidingView>
      </Animated.View>
    </GestureDetector>
  );
}

function DeckStep(props: {
  readonly symbol: "chevron.left" | "chevron.right";
  readonly label: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      hitSlop={10}
      className="h-7 w-7 items-center justify-center rounded-full border border-border"
      style={{ opacity: props.disabled ? 0.4 : 1 }}
      onPress={props.onPress}
    >
      <SymbolView
        name={props.symbol}
        size={12}
        tintColorClassName="accent-foreground-muted"
        type="monochrome"
      />
    </Pressable>
  );
}
