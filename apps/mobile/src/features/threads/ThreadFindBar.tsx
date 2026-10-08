import {
  THREAD_FIND_SCOPES,
  type ThreadFindMatch,
  type ThreadFindScope,
} from "@t3tools/client-runtime/thread-find";
import type { OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { memo, useEffect, useRef, useState } from "react";
import {
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  Text as NativeText,
  TextInput,
  type TextInputInstance,
  useWindowDimensions,
  View,
} from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { themeColorWithAlpha } from "../../lib/mobileTheme";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { threadFindSnippet } from "./thread-find-feed";
import type { ThreadFindHighlighter } from "./thread-find-highlight";
import { threadFindPreferencesAtom, updateThreadFindPreferences } from "./thread-find-store";
import { ComposerSurface } from "./ThreadComposer";
import type { ThreadFindSession } from "./use-thread-find";

const SCOPE_LABELS: Record<ThreadFindScope, string> = {
  all: "All",
  user: "You",
  assistant: "Agent",
  tool: "Tools",
  reasoning: "Thinking",
};
const LIST_ROW_HEIGHT = 44;
const OPTION_TOGGLES = [
  { key: "caseSensitive", label: "Aa", accessibilityLabel: "Match case" },
  { key: "wholeWord", label: "Word", accessibilityLabel: "Whole word" },
  { key: "regex", label: ".*", accessibilityLabel: "Regular expression" },
] as const;

function toolLabel(item: OrchestrationV2ProjectedTurnItem["item"] | undefined): string {
  switch (item?.type) {
    case "command_execution":
      return "Ran";
    case "file_change":
      return "Edited";
    case "file_search":
      return "Searched";
    case "web_search":
      return "Web search";
    case "dynamic_tool":
      return item.toolName ?? "Tool";
    case "subagent":
      return "Subagent";
    case "approval_request":
      return "Approval";
    case "user_input_request":
      return "Question";
    default:
      return "Tool";
  }
}

function matchSourceLabel(
  match: ThreadFindMatch,
  item: OrchestrationV2ProjectedTurnItem | undefined,
): string {
  switch (match.source) {
    case "user":
      return "You";
    case "assistant":
      return "Agent";
    case "reasoning":
      return "Thinking";
    case "tool":
      return toolLabel(item?.item);
  }
}

function FindChip(props: {
  readonly label: string;
  readonly accessibilityLabel: string;
  readonly selected: boolean;
  readonly onPress: () => void;
  readonly mono?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityState={{ selected: props.selected }}
      onPress={props.onPress}
      className={cn(
        "h-8 items-center justify-center rounded-full border px-3",
        props.selected ? "border-primary bg-primary" : "border-border bg-card",
      )}
    >
      <Text
        className={cn(
          "text-xs tabular-nums",
          props.mono ? "font-mono" : "font-t3-medium",
          props.selected ? "text-primary-foreground" : "text-foreground-muted",
        )}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

function FindIconButton(props: {
  readonly icon: AppSymbolName;
  readonly accessibilityLabel: string;
  readonly disabled?: boolean;
  readonly selected?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityState={{ disabled: props.disabled, selected: props.selected }}
      disabled={props.disabled}
      hitSlop={4}
      onPress={props.onPress}
      className={cn(
        "h-9 w-9 items-center justify-center rounded-full disabled:opacity-35",
        props.selected && "bg-subtle-strong",
      )}
    >
      <SymbolView
        name={props.icon}
        size={16}
        tintColorClassName="accent-foreground"
        type="monochrome"
      />
    </Pressable>
  );
}

const MatchRow = memo(function MatchRow(props: {
  readonly match: ThreadFindMatch;
  readonly item: OrchestrationV2ProjectedTurnItem | undefined;
  readonly selected: boolean;
  readonly highlighter: ThreadFindHighlighter | null;
  readonly onPick: (key: string) => void;
}) {
  const snippet = threadFindSnippet(props.match.excerpt);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: props.selected }}
      onPress={() => props.onPick(props.match.key)}
      className={cn(
        "flex-row items-center gap-2.5 px-3 active:bg-subtle",
        props.selected && "bg-subtle",
      )}
      style={{ height: LIST_ROW_HEIGHT }}
    >
      <Text
        className="w-[72px] shrink-0 font-t3-medium text-xs text-foreground-muted"
        numberOfLines={1}
      >
        {matchSourceLabel(props.match, props.item)}
      </Text>
      <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
        {snippet.before}
        <NativeText
          style={{
            backgroundColor: props.selected
              ? props.highlighter?.currentColor
              : props.highlighter?.color,
          }}
        >
          {snippet.match}
        </NativeText>
        {snippet.after}
      </Text>
      {props.match.loaded ? null : (
        <Text className="shrink-0 text-2xs text-foreground-muted">not loaded</Text>
      )}
    </Pressable>
  );
});

function counterLabel(session: ThreadFindSession, query: string): string | null {
  if (query.length === 0) return null;
  if (session.results.invalid !== null) return "Invalid regex";
  if (session.wrapped !== null) return "Wrapped";
  const total = session.results.matches.length;
  if (total === 0) return session.pending ? null : "No matches";
  return `${Math.max(0, session.index) + 1} of ${total}${session.results.truncated ? "+" : ""}`;
}

export function ThreadFindBar(props: {
  readonly session: ThreadFindSession;
  /**
   * Changes whenever find is explicitly asked to open, to focus the field and
   * select its query. Null when find opened on a thread search hit.
   */
  readonly focusRequest: number | null;
  readonly bottomInset: number;
  readonly contentMaxWidth?: number | undefined;
  readonly onFocusChange: (focused: boolean) => void;
  readonly onDone: () => void;
  /** Left out where the thread list cannot show the query it would filter by. */
  readonly onSearchAllThreads?: ((query: string) => void) | undefined;
}) {
  const { session, onSearchAllThreads } = props;
  const { preferences } = session;
  const inputRef = useRef<TextInputInstance>(null);
  const listRef = useRef<FlatList<ThreadFindMatch>>(null);
  const [listOpen, setListOpen] = useState(false);
  const windowHeight = useWindowDimensions().height;
  const { themeVariables } = useAppearancePreferences();
  const total = session.results.matches.length;
  const invalid = session.results.invalid !== null;
  const counter = counterLabel(session, preferences.query);

  // Only an explicit open request focuses and selects; typing must not reselect
  // the query, and a thread search hit leaves the keyboard down.
  useEffect(() => {
    if (props.focusRequest === null) return;
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelection(
        0,
        appAtomRegistry.get(threadFindPreferencesAtom).query.length,
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [props.focusRequest]);

  useEffect(() => {
    if (listOpen && session.index >= 0) {
      listRef.current?.scrollToIndex({ index: session.index, animated: false, viewPosition: 0.5 });
    }
  }, [listOpen, session.index]);

  return (
    <View
      className="px-[12px]"
      style={{
        paddingTop: 6,
        paddingBottom: props.bottomInset + 6,
        backgroundColor:
          Platform.OS === "android"
            ? themeColorWithAlpha(themeVariables["--color-composer-panel"], 1)
            : undefined,
      }}
    >
      <View
        className={
          Platform.OS === "android"
            ? "hidden"
            : "absolute inset-0 bg-linear-to-b from-screen/0 via-screen/60 to-screen/90"
        }
        pointerEvents="none"
      />
      <View className="w-full gap-2 self-center" style={{ maxWidth: props.contentMaxWidth }}>
        {listOpen && preferences.query.length > 0 ? (
          <View
            className="overflow-hidden rounded-2xl border border-border bg-card"
            style={{ maxHeight: windowHeight * 0.4 }}
          >
            <FlatList
              ref={listRef}
              data={session.results.matches}
              keyExtractor={(match) => match.key}
              keyboardShouldPersistTaps="handled"
              getItemLayout={(_, index) => ({
                length: LIST_ROW_HEIGHT,
                offset: LIST_ROW_HEIGHT * index,
                index,
              })}
              renderItem={({ item: match, index }) => (
                <MatchRow
                  match={match}
                  item={session.items.get(match.itemKey)}
                  selected={index === session.index}
                  highlighter={session.highlighter}
                  onPick={session.pick}
                />
              )}
              ListFooterComponent={
                onSearchAllThreads === undefined ? undefined : (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => onSearchAllThreads(preferences.query)}
                    className="flex-row items-center gap-2 border-t border-border px-3 active:bg-subtle"
                    style={{ height: LIST_ROW_HEIGHT }}
                  >
                    <SymbolView
                      name="magnifyingglass"
                      size={14}
                      tintColorClassName="accent-foreground-muted"
                      type="monochrome"
                    />
                    <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
                      {`Search all threads for "${preferences.query}"`}
                    </Text>
                  </Pressable>
                )
              }
            />
          </View>
        ) : null}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerClassName="items-center gap-1.5"
        >
          {THREAD_FIND_SCOPES.map((scope) => (
            <FindChip
              key={scope}
              label={
                preferences.query.length > 0 && !invalid
                  ? `${SCOPE_LABELS[scope]} ${session.results.counts[scope]}`
                  : SCOPE_LABELS[scope]
              }
              accessibilityLabel={`${SCOPE_LABELS[scope]} matches`}
              selected={preferences.scope === scope}
              onPress={() => updateThreadFindPreferences({ scope })}
            />
          ))}
          <View className="mx-1 h-5 w-px bg-border" />
          {OPTION_TOGGLES.map((toggle) => (
            <FindChip
              key={toggle.key}
              label={toggle.label}
              accessibilityLabel={toggle.accessibilityLabel}
              selected={preferences[toggle.key]}
              mono={toggle.key === "regex"}
              onPress={() =>
                updateThreadFindPreferences({ [toggle.key]: !preferences[toggle.key] })
              }
            />
          ))}
          {session.loadedOnly ? (
            <Text className="pl-1 text-2xs text-foreground-muted">Regex: loaded messages only</Text>
          ) : null}
        </ScrollView>
        <View className="flex-row items-center gap-2">
          <View className="min-w-0 flex-1">
            <ComposerSurface style={{ borderRadius: 27, overflow: "hidden", paddingVertical: 2 }}>
              <View className="h-[46px] flex-row items-center gap-1 pr-1 pl-3.5">
                <SymbolView
                  name="magnifyingglass"
                  size={15}
                  tintColorClassName="accent-foreground-muted"
                  type="monochrome"
                />
                <TextInput
                  ref={inputRef}
                  accessibilityLabel="Find in thread"
                  placeholder="Find in thread"
                  placeholderTextColorClassName="accent-placeholder"
                  cursorColorClassName="accent-focus"
                  selectionColorClassName="accent-focus/32"
                  autoCapitalize="none"
                  autoCorrect={false}
                  spellCheck={false}
                  returnKeyType="search"
                  submitBehavior="submit"
                  className={cn(
                    "h-[40px] min-w-0 flex-1 px-1.5 py-0 font-sans text-base",
                    invalid ? "text-adaptive-rose-600-400" : "text-foreground",
                  )}
                  value={preferences.query}
                  onChangeText={(query) => updateThreadFindPreferences({ query })}
                  onSubmitEditing={() => session.step("older")}
                  onFocus={() => props.onFocusChange(true)}
                  onBlur={() => props.onFocusChange(false)}
                />
                {session.pending ? (
                  <View
                    accessibilityLabel="Searching history"
                    className="h-2 w-2 rounded-full border border-foreground-muted"
                  />
                ) : null}
                {counter !== null ? (
                  <Text
                    accessibilityLiveRegion="polite"
                    className={cn(
                      "shrink-0 pr-1 text-xs tabular-nums",
                      invalid ? "text-adaptive-rose-600-400" : "text-foreground-muted",
                    )}
                    numberOfLines={1}
                  >
                    {counter}
                  </Text>
                ) : null}
                <FindIconButton
                  icon="chevron.up"
                  accessibilityLabel="Previous match"
                  disabled={total === 0}
                  onPress={() => session.step("older")}
                />
                <FindIconButton
                  icon="chevron.down"
                  accessibilityLabel="Next match"
                  disabled={total === 0}
                  onPress={() => session.step("newer")}
                />
                <FindIconButton
                  icon="line.3.horizontal"
                  accessibilityLabel={listOpen ? "Hide matches" : "Show matches"}
                  disabled={preferences.query.length === 0}
                  selected={listOpen}
                  onPress={() => setListOpen((open) => !open)}
                />
              </View>
            </ComposerSurface>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Done"
            hitSlop={6}
            onPress={props.onDone}
            className="h-11 justify-center px-1.5"
          >
            <Text className="font-t3-medium text-base text-foreground">Done</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}
