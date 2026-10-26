import { useEffect, useRef } from "react";
import { Platform, Pressable, TextInput, type TextInputInstance, View } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { themeColorWithAlpha } from "../../lib/mobileTheme";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { ComposerSurface } from "./ThreadComposer";
import type { ThreadFindSession } from "./use-thread-find";

function FindIconButton(props: {
  readonly icon: AppSymbolName;
  readonly accessibilityLabel: string;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      hitSlop={4}
      onPress={props.onPress}
      className="h-9 w-9 items-center justify-center rounded-full disabled:opacity-35"
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

function counterLabel(session: ThreadFindSession): string | null {
  if (session.query.trim().length === 0) return null;
  if (session.status === "error") return "Search failed";
  if (session.status === "searching") return "Searching…";
  if (session.matchCount === 0) return "No matches";
  return `${session.activeIndex + 1} of ${session.matchCount}`;
}

/** Takes the composer's place while find is open. */
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
}) {
  const { session } = props;
  const inputRef = useRef<TextInputInstance>(null);
  const { themeVariables } = useAppearancePreferences();
  const counter = counterLabel(session);
  const navigationDisabled = session.matchCount === 0 || session.status === "searching";

  // Only an explicit open request focuses and selects; typing must not reselect
  // the query, and a thread search hit leaves the keyboard down.
  const queryLength = session.query.length;
  // oxlint-disable-next-line t3code/react-effect-budget -- focusing the native input once the open request has rendered it is imperative.
  useEffect(() => {
    if (props.focusRequest === null) return;
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelection(0, queryLength);
    });
    return () => cancelAnimationFrame(frame);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Selecting on every keystroke would fight the reader's typing.
  }, [props.focusRequest]);

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
      <View
        className="w-full flex-row items-center gap-2 self-center"
        style={{ maxWidth: props.contentMaxWidth }}
      >
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
                maxLength={200}
                returnKeyType="search"
                submitBehavior="submit"
                className="h-[40px] min-w-0 flex-1 px-1.5 py-0 font-sans text-base text-foreground"
                value={session.query}
                onChangeText={session.setQuery}
                onSubmitEditing={session.next}
                onFocus={() => props.onFocusChange(true)}
                onBlur={() => props.onFocusChange(false)}
              />
              {counter !== null ? (
                <Text
                  accessibilityLiveRegion="polite"
                  className={cn(
                    "shrink-0 pr-1 text-xs tabular-nums",
                    session.status === "error" || session.matchCount === 0
                      ? "text-adaptive-rose-600-400"
                      : "text-foreground-muted",
                  )}
                  numberOfLines={1}
                >
                  {counter}
                </Text>
              ) : null}
              {session.status === "error" ? (
                <FindIconButton
                  icon="arrow.clockwise"
                  accessibilityLabel="Retry search"
                  onPress={session.retry}
                />
              ) : null}
              <FindIconButton
                icon="chevron.up"
                accessibilityLabel="Previous match"
                disabled={navigationDisabled}
                onPress={session.previous}
              />
              <FindIconButton
                icon="chevron.down"
                accessibilityLabel="Next match"
                disabled={navigationDisabled}
                onPress={session.next}
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
  );
}
