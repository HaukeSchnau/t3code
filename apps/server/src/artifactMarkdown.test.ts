import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

import { readArtifactMarkdown } from "./artifactMarkdown.ts";

const url = "https://files.schnau.dev/reports/report.md?revision=2#details";

describe("published Markdown reader", () => {
  it.effect("reads UTF-8 across chunk boundaries without forwarding credentials", () =>
    Effect.gen(function* () {
      const bytes = new TextEncoder().encode("# Café\n\n```mermaid\ngraph LR\n A --> B\n```\n");
      const fetchDocument = vi.fn<NonNullable<Parameters<typeof readArtifactMarkdown>[1]>>(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(bytes.slice(0, 6));
                controller.enqueue(bytes.slice(6));
                controller.close();
              },
            }),
          ),
      );
      const result = yield* readArtifactMarkdown(url, fetchDocument);
      expect(result.contents).toBe(new TextDecoder().decode(bytes));
      expect(fetchDocument).toHaveBeenCalledWith(
        url,
        expect.objectContaining({
          redirect: "error",
          credentials: "omit",
          cache: "no-store",
        }),
      );
      expect(fetchDocument.mock.calls[0]?.[1]?.headers).toBeUndefined();
    }),
  );

  it.effect("rejects other origins and file types before making a request", () =>
    Effect.gen(function* () {
      const fetchDocument = vi.fn<NonNullable<Parameters<typeof readArtifactMarkdown>[1]>>();
      for (const href of [
        "https://example.com/report.md",
        "https://files.schnau.dev.evil.test/report.md",
        "http://files.schnau.dev/report.md",
        "https://user:password@files.schnau.dev/report.md",
        "https://files.schnau.dev:8443/report.md",
        "https://files.schnau.dev/report.html",
        "https://files.schnau.dev/%zz.md",
      ]) {
        const result = yield* readArtifactMarkdown(href, fetchDocument).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
      }
      expect(fetchDocument).not.toHaveBeenCalled();
    }),
  );

  it.effect("reports HTTP and network failures", () =>
    Effect.gen(function* () {
      for (const fetchDocument of [
        vi.fn<NonNullable<Parameters<typeof readArtifactMarkdown>[1]>>(
          async () => new Response("Not found", { status: 404 }),
        ),
        vi.fn<NonNullable<Parameters<typeof readArtifactMarkdown>[1]>>(async () => {
          throw new TypeError("fetch failed");
        }),
      ]) {
        const result = yield* readArtifactMarkdown(url, fetchDocument).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure._tag).toBe("ArtifactReadMarkdownError");
      }
    }),
  );

  it.effect("cancels oversized responses even without Content-Length", () =>
    Effect.gen(function* () {
      const cancel = vi.fn();
      const fetchDocument = vi.fn<NonNullable<Parameters<typeof readArtifactMarkdown>[1]>>(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
              },
              cancel,
            }),
          ),
      );
      const result = yield* readArtifactMarkdown(url, fetchDocument).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.message).toContain("2 MiB");
      expect(cancel).toHaveBeenCalledOnce();
    }),
  );
});
