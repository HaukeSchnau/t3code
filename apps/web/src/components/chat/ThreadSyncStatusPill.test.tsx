import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ThreadSyncStatusPill } from "./ThreadSyncStatusPill";

describe("ThreadSyncStatusPill", () => {
  it("renders the cache-miss loading phase", () => {
    const markup = renderToStaticMarkup(<ThreadSyncStatusPill />);

    expect(markup).toContain('role="status"');
    expect(markup).toContain("Loading messages...");
    expect(markup).not.toContain("Syncing messages...");
    expect(markup).not.toContain("animate-");
  });
});
