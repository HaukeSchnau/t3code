import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type HtmlRenderListPagesInput,
  type HtmlRenderPage,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

// The server's page list over `state.pages`, newest first, read again whenever they change.
const state = vi.hoisted(() => ({
  pages: [] as ReadonlyArray<HtmlRenderPage>,
  version: 0,
  listeners: new Set<() => void>(),
}));

vi.mock(import("../../state/htmlRender"), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    htmlRenderEnvironment: {
      ...original.htmlRenderEnvironment,
      pages: ((target: unknown) => target) as never,
    },
  };
});

vi.mock(import("../../state/query"), async (importOriginal) => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  };
  const sortKey = (page: HtmlRenderPage) => `${page.latestPublishedAt}|${page.renderId}`;
  return {
    ...(await importOriginal()),
    useEnvironmentQuery: ((target: { readonly input: HtmlRenderListPagesInput }) => {
      useSyncExternalStore(subscribe, () => state.version);
      const { cursor, limit = 50 } = target.input;
      const after =
        cursor === undefined ? state.pages : state.pages.filter((page) => sortKey(page) < cursor);
      const pages = after.slice(0, limit);
      return {
        data: { pages, nextCursor: after.length > limit ? sortKey(pages.at(-1)!) : null },
        error: null,
      };
    }) as never,
  };
});

import "~/index.css";
import { act, render } from "../../../test/render";
import { PagesEnvironmentSection } from "./PagesPage";

const pageAt = (second: number): HtmlRenderPage => {
  const at = new Date(Date.UTC(2026, 10, 19, 10, 0, second)).toISOString();
  const name = `page ${String(second).padStart(2, "0")}`;
  return {
    renderId: name,
    threadId: ThreadId.make("thread:pages"),
    projectId: ProjectId.make("project:pages"),
    threadTitle: name,
    title: name,
    latestAttachmentId: name,
    firstPublishedAt: at,
    latestPublishedAt: at,
    versionCount: 1,
    seenAt: null,
    ask: null,
  };
};

function setup(pages: ReadonlyArray<HtmlRenderPage>) {
  state.pages = pages;
  state.version = 0;
  state.listeners.clear();
}

const setPages = (pages: ReadonlyArray<HtmlRenderPage>) =>
  act(() => {
    state.pages = pages;
    state.version += 1;
    for (const listener of state.listeners) listener();
  });

const newestFirst = (seconds: ReadonlyArray<number>) =>
  seconds.toSorted((left, right) => right - left).map(pageAt);

it("loads more after the rows as they stand when a page is published or goes away", async () => {
  const seconds = Array.from({ length: 60 }, (_, second) => second);
  setup(newestFirst(seconds));
  await using screen = await render(
    <PagesEnvironmentSection
      environmentId={EnvironmentId.make("environment:pages")}
      label={null}
      filter="all"
      onOpen={() => undefined}
      onOpenThread={() => undefined}
    />,
  );
  const shown = () =>
    screen
      .getByRole("button", { name: /^Open the thread / })
      .elements()
      .map((button) => button.getAttribute("aria-label")!.replace("Open the thread ", ""));
  const titles = (pages: ReadonlyArray<HtmlRenderPage>) => pages.map((page) => page.title);

  await screen.getByRole("button", { name: "Load more" }).click();
  await vi.waitFor(() => expect(shown()).toEqual(titles(newestFirst(seconds))));

  // The newest page pushes the first batch's last row into the second batch.
  await setPages(newestFirst([...seconds, 60]));
  await vi.waitFor(() => expect(shown()).toEqual(titles(newestFirst([...seconds, 60]))));

  // A row gone from the first batch pulls the second batch's first row up, once.
  const remaining = [...seconds, 60].filter((second) => second !== 55);
  await setPages(newestFirst(remaining));
  await vi.waitFor(() => expect(shown()).toEqual(titles(newestFirst(remaining))));
});
