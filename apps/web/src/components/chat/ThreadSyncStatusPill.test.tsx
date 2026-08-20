import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ThreadSyncStatusPill } from "./ThreadSyncStatusPill";

describe("ThreadSyncStatusPill", () => {
  it("renders the cache-miss loading phase", () => {
    const markup = renderToStaticMarkup(<ThreadSyncStatusPill />);

    expect(markup).toContain('role="status"');
    expect(markup).toContain('data-thread-sync-drawer="true"');
    expect(markup).toContain("chat-composer-drawer-surface");
    expect(markup).toContain("chat-composer-drawer-attached");
    expect(markup).toContain("chat-composer-drawer-slot");
    expect(markup).toContain("pb-[calc(var(--chat-composer-attachment-overlap)_+_0.375rem)]");
    expect(markup).toContain(label);
    expect(markup).toContain("Loading messages...");
    expect(markup).not.toContain("Syncing messages...");
    expect(markup).not.toContain("animate-");
  });
});
