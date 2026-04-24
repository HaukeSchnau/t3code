import { afterEach, describe, expect, it, vi } from "vitest";

function installWindow(url = "http://localhost:5173/") {
  vi.stubGlobal("window", {
    location: new URL(url),
  });
}

describe("chooseVoiceMimeType", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("prefers opus webm when supported", async () => {
    vi.stubGlobal("MediaRecorder", {
      isTypeSupported: (mimeType: string) => mimeType === "audio/webm;codecs=opus",
    });

    const { chooseVoiceMimeType } = await import("./voiceTranscription");

    expect(chooseVoiceMimeType()).toBe("audio/webm;codecs=opus");
  });

  it("falls back to webm when opus webm is unsupported", async () => {
    vi.stubGlobal("MediaRecorder", {
      isTypeSupported: (mimeType: string) => mimeType === "audio/webm",
    });

    const { chooseVoiceMimeType } = await import("./voiceTranscription");

    expect(chooseVoiceMimeType()).toBe("audio/webm");
  });
});

describe("transcribeVoiceBlob", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("posts multipart audio to the primary environment with browser credentials", async () => {
    installWindow();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ text: " hello voice " }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { transcribeVoiceBlob } = await import("./voiceTranscription");
    const transcript = await transcribeVoiceBlob(
      new Blob([new Uint8Array([1, 2, 3])], {
        type: "audio/webm",
      }),
    );

    expect(transcript).toBe("hello voice");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:5173/api/voice/transcribe");
    expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBe("include");
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBeInstanceOf(FormData);
    const formData = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    expect(formData.get("file")).toBeInstanceOf(Blob);
  });

  it("throws the server error message on failed transcription", async () => {
    installWindow();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ error: "Codex auth is unavailable." }), {
          headers: { "content-type": "application/json" },
          status: 503,
        }),
      ),
    );

    const { transcribeVoiceBlob } = await import("./voiceTranscription");

    await expect(
      transcribeVoiceBlob(new Blob([new Uint8Array([1])], { type: "audio/webm" })),
    ).rejects.toThrow("Codex auth is unavailable.");
  });
});
