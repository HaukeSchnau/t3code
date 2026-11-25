import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

type RelayMessage = (event: { nativeEvent: { data: string } }) => void;

const harness = vi.hoisted(() => ({
  openedLinks: [] as string[],
  html: "",
  onMessage: null as RelayMessage | null,
}));

type Children = { children?: ReactNode };

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  View: ({ children }: Children) => <div>{children}</div>,
  Pressable: ({ children }: Children) => <div>{children}</div>,
}));
vi.mock("react-native-webview", () => ({
  WebView: (props: { source: { html: string }; onMessage: RelayMessage }) => {
    harness.html = props.source.html;
    harness.onMessage = props.onMessage;
    return null;
  },
}));
vi.mock("react-native-keyboard-controller", () => ({
  useKeyboardState: (select: (state: { height: number }) => number) => select({ height: 0 }),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../components/ui/useBarInset", () => ({ useContentTopInset: () => 0 }));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: Children) => <span>{children}</span>,
}));
vi.mock("../../lib/htmlRenderTheme", () => ({
  mobileHtmlRenderTheme: () => ({ variables: {} }),
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({}),
}));
vi.mock("../../state/assets", () => ({
  useAssetUrlState: () => ({ _tag: "Initial" }),
  useRefreshAssetUrl: () => async () => null,
}));
vi.mock("../../state/htmlRender", () => ({
  htmlRenderEnvironment: { callTool: {}, stateQuery: () => null },
  htmlRenderStateStore: { view: () => () => {}, read: () => undefined, save: () => {} },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ isSuccess: false, error: null, data: undefined }),
}));
vi.mock("../../state/thread-outbox", () => ({ enqueueThreadOutboxMessage: vi.fn() }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../needs-you/triageSession", () => ({ triagePageSend: vi.fn() }));
vi.mock("../pages/useHtmlRenderSeen", () => ({ useMarkHtmlRenderSeenInView: () => {} }));
vi.mock("../../native/useOpenPullRequest", () => ({
  useOpenPullRequest: () => async (url: string) => {
    harness.openedLinks.push(url);
    return true;
  },
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({}) }));

import { HtmlRenderWebView } from "./HtmlRenderWebView";

it("opens a page's link the way the thread's own links open, only from a tap in the page", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement("div"));
  await act(async () =>
    root.render(<HtmlRenderWebView uri="https://assets.test/render.html" title="Links" nested />),
  );
  const secret = JSON.parse(/secret=("[^"]+")/.exec(harness.html)![1]!) as string;
  const relay = (envelope: { secret: string; active: boolean }, url: string) =>
    act(async () =>
      harness.onMessage?.({
        nativeEvent: {
          data: JSON.stringify({
            ...envelope,
            message: { jsonrpc: "2.0", id: 1, method: "ui/open-link", params: { url } },
          }),
        },
      }),
    );

  await relay({ secret, active: false }, "https://example.test/timer");
  await relay({ secret: "forged", active: true }, "https://example.test/forged");
  const issueUrl = "https://github.com/pingdotgg/t3code/issues/41939";
  await relay({ secret, active: true }, issueUrl);

  expect(harness.openedLinks).toEqual([issueUrl]);
  await act(async () => root.unmount());
});
