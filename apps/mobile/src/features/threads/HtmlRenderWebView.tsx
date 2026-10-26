import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import * as Dialog from "../../components/ui/Dialog";
import { useNavigation } from "@react-navigation/native";
import {
  HtmlRenderHostRefusal,
  makeHtmlRenderHost,
  type HtmlRenderHost,
} from "@t3tools/client-runtime/html-render";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  MessageId,
  type EnvironmentId,
  type HtmlRenderState,
  type ThreadId,
} from "@t3tools/contracts";
import {
  htmlRenderFileName,
  htmlRenderFrameHeight,
  htmlRenderResult,
  htmlRenderThemeFragment,
  htmlRenderThemeMessage,
  readHtmlRenderContentHeight,
  readHtmlRenderLinkRequest,
  type HtmlRenderReference,
  type HtmlRenderTheme,
  type HtmlRenderVersionEntry,
} from "@t3tools/shared/htmlRender";
import * as Clipboard from "expo-clipboard";
import * as Predicate from "effect/Predicate";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { Platform, Pressable, View, type ColorValue } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { mobileHtmlRenderTheme } from "../../lib/htmlRenderTheme";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { uuidv4 } from "../../lib/uuid";
import { useAssetUrlState, useRefreshAssetUrl } from "../../state/assets";
import { htmlRenderEnvironment } from "../../state/htmlRender";
import { useEnvironmentQuery } from "../../state/query";
import { enqueueThreadOutboxMessage } from "../../state/thread-outbox";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

const ROW_BOTTOM_MARGIN = 8;
const FULL_SCREEN_GUTTER = 16;
const NO_STATE: HtmlRenderState = {};

export function htmlRenderRowHeight(frameHeight: number) {
  return frameHeight + ROW_BOTTOM_MARGIN;
}

function useHtmlRenderTheme() {
  const { themeId, themeAppearance, themeVariables, systemColorsActive } =
    useAppearancePreferences();
  return useMemo(
    () =>
      mobileHtmlRenderTheme({
        themeId,
        appearance: themeAppearance,
        variables: themeVariables,
        systemColors: systemColorsActive,
        platform: Platform.OS,
      }),
    [themeId, themeAppearance, themeVariables, systemColorsActive],
  );
}

// Android exposes `ReactNativeWebView` to every frame, so the page could post to React Native
// directly. The relay wraps what it forwards with a secret only it holds, and attests whether
// the reader is using the frame, which the sandboxed page cannot fake.
function relayDocument(src: string, secret: string) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{margin:0;height:100%;background:transparent}iframe{border:0;display:block;width:100%;height:100%}</style></head>
<body><iframe id="page" sandbox="allow-scripts allow-forms" allow="clipboard-write; fullscreen"></iframe>
<script>(function(){var frame=document.getElementById("page"),secret=${JSON.stringify(secret)},loads=0,live=true;
var send=function(m){var u=navigator.userActivation;window.ReactNativeWebView.postMessage(JSON.stringify({secret:secret,active:!!(u&&u.isActive)&&document.activeElement===frame,message:m}));};
frame.addEventListener("load",function(){loads+=1;if(loads>1&&live){live=false;send({t3:"navigated"});}});
window.addEventListener("message",function(e){if(live&&e.source===frame.contentWindow)send(e.data);});
window.__t3HtmlRenderReceive=function(m){live&&frame.contentWindow&&frame.contentWindow.postMessage(m,"*");};
frame.src=${JSON.stringify(src).replace(/</g, "\\u003c")};})();</script></body></html>`;
}

const confirm = (title: string, message: string) =>
  new Promise<boolean>((resolve) => {
    Dialog.alert(
      title,
      message,
      [
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
        { text: "Allow", onPress: () => resolve(true) },
      ],
      // Android dismisses earlier alerts when showing another; a dismissed request is declined.
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });

const commandFailure = (result: {
  readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"];
}) => {
  const error = squashAtomCommandFailure(result);
  return new HtmlRenderHostRefusal(
    error instanceof Error && error.message.trim() !== "" ? error.message : "Request failed.",
  );
};

/** A render shown in a thread, which its page may send to, call tools for, and save state in. */
export interface HtmlRenderBridgeTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly renderId: string;
}

// What pages saved on this device while a view of the render is mounted, so the feed row and the
// full-screen page, which mount at once and share a cached read, start from the latest save. The
// entry goes with the last view, so a later visit reads what other devices saved since.
const savedHere = new Map<string, { state: HtmlRenderState | undefined; views: number }>();
const savedKey = (target: HtmlRenderBridgeTarget) =>
  `${target.environmentId}\u0000${target.threadId}\u0000${target.renderId}`;

/** The render's saved state: this device's latest save, else a read when the view mounts. */
export function useHtmlRenderSavedState(target: HtmlRenderBridgeTarget | undefined) {
  const key = target === undefined ? undefined : savedKey(target);
  // oxlint-disable-next-line t3code/react-effect-budget -- Counts mounted views so the local save outlives none of them.
  useEffect(() => {
    if (key === undefined) return;
    const entry = savedHere.get(key) ?? { state: undefined, views: 0 };
    savedHere.set(key, { ...entry, views: entry.views + 1 });
    return () => {
      const current = savedHere.get(key);
      if (current === undefined || current.views <= 1) savedHere.delete(key);
      else savedHere.set(key, { ...current, views: current.views - 1 });
    };
  }, [key]);
  const query = useEnvironmentQuery(
    target === undefined
      ? null
      : htmlRenderEnvironment.stateQuery({
          environmentId: target.environmentId,
          input: { threadId: target.threadId, renderId: target.renderId },
        }),
  );
  return {
    // An older server lacks the state RPC; its pages still open, without saved state.
    ready: target === undefined || query.isSuccess || query.error !== null,
    read: () =>
      (key === undefined ? undefined : savedHere.get(key)?.state) ?? query.data ?? NO_STATE,
    saved: (state: HtmlRenderState) => {
      const entry = key === undefined ? undefined : savedHere.get(key);
      if (key !== undefined && entry !== undefined) savedHere.set(key, { ...entry, state });
    },
  };
}

export function HtmlRenderWebView(props: {
  readonly uri: string;
  readonly title: string;
  readonly nested: boolean;
  readonly bridge?: HtmlRenderBridgeTarget | undefined;
  readonly state?: HtmlRenderState | undefined;
  readonly onStateSaved?: ((state: HtmlRenderState) => void) | undefined;
  readonly onContentHeight?: ((height: number) => void) | undefined;
  readonly onLoadError?: () => void;
}) {
  const theme = useHtmlRenderTheme();
  const [initialTheme] = useState(theme);
  const [initialState] = useState(props.state);
  const [secret] = useState(uuidv4);
  const [generation, setGeneration] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const webView = useRef<WebView<object>>(null);
  const host = useRef<HtmlRenderHost | null>(null);
  const crashes = useRef(0);
  const shownTheme = useRef<HtmlRenderTheme | null>(null);
  const source = useMemo(
    () => ({
      html: relayDocument(props.uri + htmlRenderThemeFragment(initialTheme, initialState), secret),
    }),
    [props.uri, initialTheme, initialState, secret],
  );
  const post = (message: unknown) =>
    webView.current?.injectJavaScript(
      `window.__t3HtmlRenderReceive&&window.__t3HtmlRenderReceive(${JSON.stringify(message)});true;`,
    );
  // oxlint-disable-next-line t3code/react-effect-budget -- Posts app theme changes into the loaded page.
  useEffect(() => {
    if (shownTheme.current === null || shownTheme.current === theme) return;
    shownTheme.current = theme;
    webView.current?.injectJavaScript(
      `window.__t3HtmlRenderReceive&&window.__t3HtmlRenderReceive(${JSON.stringify(htmlRenderThemeMessage(theme))});true;`,
    );
  }, [theme]);

  const callTool = useAtomCommand(htmlRenderEnvironment.callTool, { reportFailure: false });
  const setState = useAtomCommand(htmlRenderEnvironment.setState, { reportFailure: false });
  const readLive = useEffectEvent(() => ({
    bridge: props.bridge,
    title: props.title,
    onStateSaved: props.onStateSaved,
    callTool,
    setState,
  }));
  const bridged = props.bridge !== undefined;
  // oxlint-disable-next-line t3code/react-effect-budget -- Each page document gets one host; it answers until the document goes away.
  useEffect(() => {
    const live = () => {
      const current = readLive();
      if (current.bridge === undefined) throw new HtmlRenderHostRefusal("This page has no thread.");
      return { ...current, bridge: current.bridge };
    };
    const documentHost = makeHtmlRenderHost({
      post: (message) =>
        webView.current?.injectJavaScript(
          `window.__t3HtmlRenderReceive&&window.__t3HtmlRenderReceive(${JSON.stringify(message)});true;`,
        ),
      copy: (text) => Clipboard.setStringAsync(text).then(() => undefined),
      // Each page document gets its own host, so its render and title are fixed for the host's life.
      bridge: bridged
        ? {
            renderId: live().bridge.renderId,
            title: live().title,
            send: async (message) => {
              const { environmentId, threadId } = live().bridge;
              await enqueueThreadOutboxMessage({
                environmentId,
                threadId,
                messageId: MessageId.make(uuidv4()),
                commandId: CommandId.make(uuidv4()),
                text: message.text,
                context: message.context,
                attachments: [],
                dispatchMode: "queue",
                createdAt: new Date().toISOString(),
              });
            },
            callTool: async (input) => {
              const current = live();
              const { environmentId, threadId, renderId } = current.bridge;
              const result = await current.callTool({
                environmentId,
                input: { threadId, renderId, ...input },
              });
              if (result._tag !== "Success") throw commandFailure(result);
              return result.value;
            },
            confirm: ({ page, tool, arguments: args }) =>
              confirm(`Allow ${page} to run ${tool}?`, JSON.stringify(args, null, 2)),
            saveState: (state) => {
              const current = live();
              const { environmentId, threadId, renderId } = current.bridge;
              current.onStateSaved?.(state);
              void current.setState({ environmentId, input: { threadId, renderId, state } });
            },
          }
        : undefined,
    });
    host.current = documentHost;
    return () => {
      documentHost.dispose();
      if (host.current === documentHost) host.current = null;
    };
  }, [bridged]);

  const restart = () => {
    crashes.current += 1;
    if (crashes.current > 1) {
      props.onLoadError?.();
      return;
    }
    shownTheme.current = null;
    setLoaded(false);
    setGeneration((value) => value + 1);
  };

  const receive = (event: WebViewMessageEvent) => {
    let envelope: unknown;
    try {
      envelope = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    if (!Predicate.isObject(envelope) || envelope.secret !== secret) return;
    const message = envelope.message;
    const active = envelope.active === true;
    if (Predicate.isObject(message) && message.t3 === "navigated") {
      host.current?.dispose();
      props.onLoadError?.();
      return;
    }
    const height = readHtmlRenderContentHeight(message);
    if (height !== undefined) {
      if (!loaded) {
        setLoaded(true);
        shownTheme.current = initialTheme;
        if (theme !== initialTheme) post(htmlRenderThemeMessage(theme));
      }
      props.onContentHeight?.(height);
      return;
    }
    const link = readHtmlRenderLinkRequest(message);
    if (link !== undefined) {
      // A page must not leave T3 on a timer; only a tap in it opens a link.
      if (active) void tryOpenExternalUrl(link.url, "html-render");
      post(htmlRenderResult(link.id));
      return;
    }
    host.current?.receive(message, { active });
  };

  return (
    <View
      style={
        props.nested
          ? { flex: 1 }
          : {
              flex: 1,
              paddingHorizontal: FULL_SCREEN_GUTTER,
              backgroundColor: theme.variables["--background"],
            }
      }
    >
      <WebView<object>
        key={generation}
        ref={webView}
        source={source}
        accessibilityLabel={props.title}
        style={{ flex: 1, backgroundColor: "transparent" }}
        originWhitelist={["*"]}
        allowsInlineMediaPlayback
        automaticallyAdjustContentInsets={!props.nested}
        bounces={!props.nested}
        // The frame fits the page in the feed; the page scrolls inside it when full screen.
        scrollEnabled={false}
        overScrollMode="never"
        setSupportMultipleWindows={false}
        // Android misreports nested frames as top-level; rely on the frame sandbox there.
        onShouldStartLoadWithRequest={(request) =>
          Platform.OS === "android" || request.isTopFrame === false || request.url === "about:blank"
        }
        onMessage={receive}
        onError={props.onLoadError}
        onContentProcessDidTerminate={restart}
        onRenderProcessGone={restart}
      />
      {loaded ? null : (
        <View pointerEvents="none" className="absolute inset-0 items-center justify-center">
          <AppActivityIndicator />
        </View>
      )}
    </View>
  );
}

/**
 * One render and its versions in the feed. The feed owns which version shows and the page's
 * reported height, so the row it sizes matches the frame.
 */
export function ThreadHtmlRender(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly render: HtmlRenderReference;
  readonly versions: ReadonlyArray<HtmlRenderVersionEntry>;
  /** Undefined follows the newest version. */
  readonly selected: number | undefined;
  readonly onSelect: (index: number | undefined) => void;
  readonly contentHeight: number | undefined;
  readonly onContentHeight: (attachmentId: string, height: number) => void;
  readonly frameWidth: number;
  readonly iconColor: ColorValue;
}) {
  const navigation = useNavigation();
  const last = props.versions.length - 1;
  const index = props.selected === undefined ? last : Math.min(props.selected, last);
  const shown = props.versions[index]?.htmlRender ?? props.render;
  const { attachmentId, title } = shown;
  const height = htmlRenderFrameHeight(shown, props.frameWidth, props.contentHeight);
  const fileName = htmlRenderFileName(title);
  const bridge = {
    environmentId: props.environmentId,
    threadId: props.threadId,
    renderId: props.render.attachmentId,
  };
  const savedState = useHtmlRenderSavedState(bridge);
  const resource = useMemo(
    () => ({
      _tag: "attachment" as const,
      attachmentId,
      fileName,
      mimeType: "text/html",
      disposition: "inline" as const,
    }),
    [attachmentId, fileName],
  );
  const asset = useAssetUrlState(props.environmentId, resource);
  const refresh = useRefreshAssetUrl(props.environmentId, resource);
  // Signed URLs are re-minted periodically; following them would reload the page.
  const [loadedUri, setLoadedUri] = useState<{ attachmentId: string; uri: string } | null>(null);
  const uri = loadedUri?.attachmentId === attachmentId ? loadedUri.uri : null;
  if (uri === null && asset._tag === "Success") setLoadedUri({ attachmentId, uri: asset.url });
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retried = useRef(false);
  const handleLoadError = () => {
    if (retried.current) {
      setFailed(true);
      return;
    }
    retried.current = true;
    void refresh().then((next) => {
      if (next === null) setFailed(true);
      else if (next !== uri) setLoadedUri({ attachmentId, uri: next });
      else setAttempt((value) => value + 1);
    });
  };
  const select = (next: number) => {
    retried.current = false;
    setFailed(false);
    props.onSelect(next >= last ? undefined : next);
  };

  return (
    <View style={{ marginBottom: ROW_BOTTOM_MARGIN }}>
      <View style={{ height }}>
        {uri !== null && !failed && savedState.ready ? (
          <HtmlRenderWebView
            key={`${uri}:${attempt}`}
            uri={uri}
            title={title}
            nested
            bridge={bridge}
            state={savedState.read()}
            onStateSaved={savedState.saved}
            onContentHeight={(contentHeight) => props.onContentHeight(attachmentId, contentHeight)}
            onLoadError={handleLoadError}
          />
        ) : failed || asset._tag === "Failure" ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Reload ${title}`}
            className="flex-1 items-center justify-center"
            onPress={() => {
              retried.current = false;
              setFailed(false);
              if (uri === null) {
                void refresh().then(
                  (next) => next !== null && setLoadedUri({ attachmentId, uri: next }),
                );
              }
            }}
          >
            <Text className="text-sm text-foreground-muted">Page unavailable</Text>
          </Pressable>
        ) : (
          <View className="flex-1 items-center justify-center">
            <AppActivityIndicator />
          </View>
        )}
        {last > 0 ? (
          <View className="absolute right-10 top-1.5 flex-row items-center gap-1">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Previous version"
              disabled={index === 0}
              hitSlop={8}
              className="h-7 w-7 items-center justify-center rounded-full border border-border/60 bg-card/80"
              style={{ opacity: index === 0 ? 0.4 : 1 }}
              onPress={() => select(index - 1)}
            >
              <SymbolView
                name="chevron.left"
                size={12}
                tintColor={props.iconColor}
                type="monochrome"
              />
            </Pressable>
            <View className="rounded-full border border-border/60 bg-card/80 px-2 py-0.5">
              <Text className="text-xs text-foreground">
                {index + 1} of {last + 1}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                index < last ? "Next version, a newer one exists" : "Next version"
              }
              disabled={index === last}
              hitSlop={8}
              className="h-7 w-7 items-center justify-center rounded-full border border-border/60 bg-card/80"
              style={{ opacity: index === last ? 0.4 : 1 }}
              onPress={() => select(index + 1)}
            >
              <SymbolView
                name="chevron.right"
                size={12}
                tintColor={props.iconColor}
                type="monochrome"
              />
              {index < last ? (
                <View className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-primary" />
              ) : null}
            </Pressable>
          </View>
        ) : null}
        {uri !== null && !failed ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open ${title}`}
            hitSlop={8}
            className="absolute right-1.5 top-1.5 h-7 w-7 items-center justify-center rounded-full border border-border/60 bg-card/80"
            onPress={() =>
              navigation.navigate("ThreadAttachment", {
                environmentId: String(props.environmentId),
                threadId: String(props.threadId),
                attachmentId,
                name: fileName,
                mimeType: "text/html",
                sizeBytes: "0",
                htmlRender: "1",
                renderId: props.render.attachmentId,
              })
            }
          >
            <SymbolView
              name="arrow.up.left.and.arrow.down.right"
              size={12}
              tintColor={props.iconColor}
              type="monochrome"
            />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
