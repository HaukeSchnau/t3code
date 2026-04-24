import { resolvePrimaryEnvironmentHttpUrl } from "./environments/primary";

const VOICE_TRANSCRIBE_PATH = "/api/voice/transcribe";
const PREFERRED_VOICE_MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm"] as const;

export function chooseVoiceMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") {
    return undefined;
  }
  return PREFERRED_VOICE_MIME_TYPES.find((mimeType) => MediaRecorder.isTypeSupported(mimeType));
}

async function readVoiceTranscriptionError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error.trim().length > 0) {
      return body.error.trim();
    }
  } catch {
    // Fall through to the status-based message below.
  }
  return response.status === 503
    ? "Codex auth is unavailable. Run `codex login` and try again."
    : "Voice transcription failed.";
}

export async function transcribeVoiceBlob(blob: Blob): Promise<string> {
  const formData = new FormData();
  const extension = blob.type.includes("mp4") ? "m4a" : blob.type.includes("wav") ? "wav" : "webm";
  formData.append("file", blob, `voice-input.${extension}`);

  const response = await fetch(resolvePrimaryEnvironmentHttpUrl(VOICE_TRANSCRIBE_PATH), {
    body: formData,
    credentials: "include",
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(await readVoiceTranscriptionError(response));
  }

  const body = (await response.json()) as { text?: unknown };
  if (typeof body.text !== "string") {
    throw new Error("Voice transcription returned an invalid response.");
  }
  return body.text.trim();
}
