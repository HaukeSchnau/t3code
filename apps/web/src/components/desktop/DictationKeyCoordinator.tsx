import { resolveTranscriptCommit } from "@t3tools/client-runtime/voice-input";
import type {
  DesktopDictationBridge,
  DesktopDictationGesture,
  DesktopDictationPill,
  DesktopDictationTarget,
  EnvironmentId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import type { DraftId } from "~/composerDraftStore";
import { useStableCallback } from "~/hooks/useStableCallback";
import { useClientSettings } from "~/hooks/useSettings";
import { useScratchProject } from "~/hooks/useScratchProject";
import { usePrimaryEnvironmentId } from "~/state/environments";
import {
  createFnPressRunner,
  reduceFnDictation,
  type FnDictationAction,
  type FnDictationPress,
} from "~/speech/fnDictation";
import { useActiveRecording } from "~/speech/activeRecording";
import { isDictationShortcutBusy, readDictationShortcutOwner } from "~/speech/useDictationShortcut";
import {
  useEnvironmentSpeechInput,
  useVoiceTranscriptionDestination,
} from "~/speech/useEnvironmentSpeechInput";

const EMPTY_DRAFT = { text: "", selection: { start: 0, end: 0 } };
const OWNER_KEY = "desktop-dictation-key";

type Session = {
  readonly pressId: number;
  gesture: DesktopDictationGesture;
  readonly target: "t3" | "app";
  context: DesktopDictationTarget | null;
  started: boolean;
  failure: string | null;
};

function bridge(): DesktopDictationBridge | undefined {
  return typeof window === "undefined" ? undefined : window.desktopBridge?.dictation;
}

const notice = (message: string, tone: "info" | "error" = "info", clickable = false) =>
  ({ kind: "notice", tone, message, clickable }) satisfies DesktopDictationPill;

/** Spaces the transcript against the text around the cursor in the other app, when it was read. */
function textForTarget(transcript: string, context: DesktopDictationTarget | null) {
  const draft = context?.draft;
  if (!draft || draft.selection.start !== draft.selection.end) return transcript;
  const snapshot = { ownerKey: OWNER_KEY, revision: 0, ...draft };
  const result = resolveTranscriptCommit(snapshot, snapshot, transcript, "auto");
  return result.kind === "commit"
    ? result.text.slice(draft.selection.start, result.selection.start)
    : transcript;
}

/**
 * Runs the desktop dictation key: presses that began in T3 drive its composer through the
 * shortcut registry; presses in other apps and Fn+Shift drafts record here, without an editor.
 */
export function DictationKeyCoordinator() {
  const destination = useVoiceTranscriptionDestination();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentId = destination.environmentId ?? primaryEnvironmentId;
  if (!bridge() || environmentId === null) return null;
  return <Coordinator environmentId={environmentId} />;
}

function Coordinator({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const navigate = useNavigate();
  const mode = useClientSettings((settings) => settings.voiceShortcutMode);
  const { saveScratchDraft, scratchEnvironmentId } = useScratchProject();
  const activeRef = useRef<FnDictationPress | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const lastDraftRef = useRef<DraftId | null>(null);
  const noticeRef = useRef(false);
  const deliveringRef = useRef(false);
  const draftSaves = useRef<Promise<unknown>>(Promise.resolve());
  const [gesture, setGesture] = useState<DesktopDictationGesture>("dictate");

  const showPill = useStableCallback((pill: DesktopDictationPill | null) => {
    noticeRef.current = pill?.kind === "notice";
    void bridge()
      ?.setPill(pill)
      .catch(() => undefined);
  });

  const deliver = async (
    session: Session,
    dictation: DesktopDictationBridge,
    transcript: string,
  ) => {
    if (session.gesture === "draft") {
      const scratch = scratchEnvironmentId(environmentId);
      // Overlapping saves into the scratch project would land in one draft and drop a transcript.
      const save = draftSaves.current.then(() =>
        scratch === null ? null : saveScratchDraft(scratch, transcript),
      );
      draftSaves.current = save.catch(() => undefined);
      const saved = await save;
      if (!saved) {
        showPill(
          notice("Could not save the draft. No environment offers no-project threads.", "error"),
        );
        return;
      }
      lastDraftRef.current = saved.draftId;
      showPill(notice("Draft saved. Click to open it.", "info", true));
      return;
    }
    if (session.target !== "app") return;
    const delivery = await dictation
      .deliver({ pressId: session.pressId, text: textForTarget(transcript, session.context) })
      .catch(() => "failed" as const);
    if (delivery === "pasted") showPill(null);
    else if (delivery === "copied") showPill(notice("Copied. Press ⌘V to paste it."));
    else showPill(notice("Could not paste the text.", "error"));
  };

  const finish = useStableCallback(async (transcript: string) => {
    const session = sessionRef.current;
    const dictation = bridge();
    if (!session || !dictation) return;
    deliveringRef.current = true;
    await deliver(session, dictation, transcript).finally(() => {
      deliveringRef.current = false;
    });
  });

  const speech = useEnvironmentSpeechInput({
    environmentId,
    ownerKey: OWNER_KEY,
    draftText: "",
    offerSetup: false,
    readDraft: () => EMPTY_DRAFT,
    commitDraft: (text) => void finish(text),
    prepareCleanup: async () => {
      const session = sessionRef.current;
      if (!session || session.target !== "app" || session.gesture === "draft")
        return { draft: null, targetApp: null };
      const context = await bridge()
        ?.prepare({ pressId: session.pressId, selection: session.gesture === "command" })
        .catch(() => null);
      session.context = context ?? null;
      return { draft: context?.draft ?? null, targetApp: context?.app ?? null };
    },
    onCommandFailure: (message) => {
      const session = sessionRef.current;
      if (session?.started) {
        session.failure = message;
        return;
      }
      // The command never started recording, so no phase change will show the message.
      sessionRef.current = null;
      showPill(notice(message, "error"));
    },
  });
  const phase = speech.state.phase;
  const isHeadlessBusy = useStableCallback(() => phase !== "idle" && phase !== "error");

  const [presses] = useState(createFnPressRunner);
  const run = useStableCallback((action: FnDictationAction) => {
    if (action.type === "start" && action.press.route === "composer") {
      const owner = readDictationShortcutOwner();
      if (!owner || owner.disabled || !owner.speech.available) return;
      void presses.start(
        "composer",
        owner.speech,
        action.press.gesture === "command" ? { intent: "command" } : undefined,
      );
      return;
    }
    if (action.type === "start") {
      const { press } = action;
      if (!speech.available) {
        showPill(notice("Choose where voice goes in T3's Voice settings first.", "error"));
        return;
      }
      sessionRef.current = { ...press, context: null, started: false, failure: null };
      setGesture(press.gesture);
      void presses.start(
        "headless",
        speech,
        press.gesture === "command" ? { intent: "command" } : undefined,
      );
      return;
    }
    const fallback =
      action.route === "composer" ? (readDictationShortcutOwner()?.speech ?? null) : speech;
    if (action.type === "stop") {
      void presses.stop(action.route, fallback);
      return;
    }
    if (action.type !== "retarget") {
      presses.cancel(action.route, fallback);
      if (action.route === "headless") {
        sessionRef.current = null;
        showPill(null);
      }
      return;
    }
    if (action.route === "composer") {
      if (action.gesture === "command") fallback?.retarget?.("command");
    } else if (sessionRef.current) {
      sessionRef.current.gesture = action.gesture;
      setGesture(action.gesture);
      speech.retarget(action.gesture === "command" ? "command" : "dictate");
    }
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the desktop app's dictation key events
  useEffect(
    () =>
      bridge()?.onEvent((event) => {
        if (event.type === "pill-click") {
          const draftId = lastDraftRef.current;
          if (draftId) void navigate({ to: "/draft/$draftId", params: { draftId } });
          return;
        }
        const busy = isHeadlessBusy() ? "headless" : isDictationShortcutBusy() ? "composer" : null;
        const result = reduceFnDictation(activeRef.current, event, { mode, busy });
        activeRef.current = result.active;
        if (result.action) run(result.action);
      }),
    [mode, navigate, run, isHeadlessBusy],
  );

  const level = Math.round(speech.level * 10) / 10;
  const preview = speech.preview ? `${speech.preview.committed}${speech.preview.tentative}` : null;
  const error = phase === "error" ? speech.state.error : null;
  const cancelSpeech = speech.cancel;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors the headless recording into the desktop pill window, outside React
  useEffect(() => {
    const session = sessionRef.current;
    if (!session) return;
    if (phase === "preparing" || phase === "recording") {
      session.started = true;
      showPill({ kind: "listening", gesture, level, preview: preview?.slice(-200) ?? null });
    } else if (phase === "transcribing" || phase === "post-processing") {
      showPill({ kind: "working", gesture });
    } else if (session.started) {
      sessionRef.current = null;
      if (phase === "error") {
        showPill(notice(session.failure ?? error ?? "Dictation failed.", "error"));
        cancelSpeech();
      } else if (!noticeRef.current && !deliveringRef.current) showPill(null);
    }
  }, [phase, gesture, level, preview, error, showPill, cancelSpeech]);

  const setupOpen = speech.setup.open;
  const closeSetup = speech.setup.setOpen;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a missing model opens setup this headless recorder cannot show, so the pill points to Voice settings
  useEffect(() => {
    if (!setupOpen || !sessionRef.current) return;
    sessionRef.current = null;
    closeSetup(false);
    showPill(notice("Download a transcription model in T3's Voice settings first.", "error"));
  }, [setupOpen, closeSetup, showPill]);

  const editorRecording = useActiveRecording();
  const [windowFocused, setWindowFocused] = useState(() => document.hasFocus());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the browser reports window focus only through events
  useEffect(() => {
    // Focus moving into a preview frame also blurs the window, but T3 still has focus then.
    const update = () => setWindowFocused(document.hasFocus());
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
    };
  }, []);
  const mirrored =
    !windowFocused && editorRecording !== null && editorRecording.ownerKey !== OWNER_KEY
      ? editorRecording
      : null;
  const mirroringRef = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- shows a T3 editor's recording in the desktop pill while T3 is in the background
  useEffect(() => {
    if (sessionRef.current) return;
    if (mirrored) {
      mirroringRef.current = true;
      showPill(
        mirrored.phase === "preparing" || mirrored.phase === "recording"
          ? {
              kind: "listening",
              gesture: mirrored.gesture,
              level: mirrored.level,
              preview: mirrored.preview?.slice(-200) ?? null,
            }
          : { kind: "working", gesture: mirrored.gesture },
      );
    } else if (mirroringRef.current) {
      mirroringRef.current = false;
      showPill(null);
    }
  }, [mirrored, showPill]);

  return null;
}
