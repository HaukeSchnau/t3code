import { ArtifactReadMarkdownError } from "@t3tools/contracts";
import { isPublishedMarkdownUrl } from "@t3tools/shared/markdownLinks";
import * as Effect from "effect/Effect";

const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;

/** Fetches a bounded document without forwarding environment credentials or following redirects. */
export const readArtifactMarkdown = Effect.fn("readArtifactMarkdown")(function* (
  url: string,
  fetchDocument: (url: string, init: RequestInit) => Promise<Response> = globalThis.fetch,
) {
  if (!isPublishedMarkdownUrl(url)) {
    return yield* new ArtifactReadMarkdownError({ message: "Invalid published Markdown URL." });
  }
  return yield* Effect.tryPromise({
    try: async (signal) => {
      const response = await fetchDocument(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Could not load Markdown (${response.status}).`);
      }
      if (!response.body) throw new Error("The document response is empty.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let contents = "";
      let byteLength = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          byteLength += value.byteLength;
          if (byteLength > MAX_MARKDOWN_BYTES)
            throw new Error("Markdown preview is limited to 2 MiB.");
          contents += decoder.decode(value, { stream: true });
        }
        return { contents: contents + decoder.decode() };
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    },
    catch: (cause) =>
      new ArtifactReadMarkdownError({
        message: cause instanceof Error ? cause.message : "Could not load Markdown.",
      }),
  });
});
