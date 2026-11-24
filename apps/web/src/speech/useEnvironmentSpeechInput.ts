import {
  cancelEnvironmentSpeechModelDownload,
  downloadEnvironmentSpeechModel,
  getEnvironmentSpeechModels,
  getEnvironmentSpeechStatus,
  getSpeechModelDownloadOutcome,
  selectEnvironmentSpeechModel,
  voiceInputBlocksSubmission,
} from "@t3tools/client-runtime/voice-input";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { AuthOrchestrationOperateScope, CLOUD_SPEECH_LABELS } from "@t3tools/contracts";
import type {
  EnvironmentId,
  EnvironmentSpeechModel,
  EnvironmentSpeechStatus,
  ProjectId,
  SpeechBenchmarkTier,
  SpeechPostProcessingIntent,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { chooseSetupSpeechModel } from "@t3tools/shared/speech";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { msg, useGT } from "gt-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { toastManager } from "../components/ui/toast";
import { m } from "../i18n/messages";
import {
  useClientSettings,
  useClientSettingsHydrated,
  useEnvironmentSettings,
} from "../hooks/useSettings";
import { useEnvironment } from "../state/environments";
import { useEnvironmentScope, usePreparedConnection } from "../state/session";
import { useAppleSpeechLocales } from "./appleSpeech";
import { preferredSpeechLanguages } from "./preferredSpeechLanguages";
import { publishRecording } from "./activeRecording";
import { runEnvironmentSpeech } from "./runEnvironmentSpeech";
import { readCleanupGrant, useAudioChoice } from "./voiceConsent";
import {
  IDLE_VOICE_STATE,
  presentVoiceOwner,
  useRetainedVoiceInputSession,
  useVoiceInputSessionActivity,
  useVoiceInputSessionSnapshot,
  type VoiceInputTarget,
} from "./voiceInputSession";

/** A product name, shown untranslated. */
export const APPLE_SPEECH_LABEL = "Apple Speech";

const INITIAL_SETUP = {
  open: false,
  step: 0,
  model: null as EnvironmentSpeechModel | null,
  language: null as string | null,
  downloading: false,
  catalogFailed: false,
  error: null as string | null,
};

// Every mounted editor shares one status probe per destination; starting a recording refreshes it.
const statusProbes = new WeakMap<PreparedConnection, Promise<EnvironmentSpeechStatus>>();
function probeSpeechStatus(prepared: PreparedConnection, refresh = false) {
  const cached = refresh ? undefined : statusProbes.get(prepared);
  if (cached) return cached;
  const probe = runEnvironmentSpeech(getEnvironmentSpeechStatus(prepared));
  statusProbes.set(prepared, probe);
  probe.catch(() => {
    if (statusProbes.get(prepared) === probe) statusProbes.delete(prepared);
  });
  return probe;
}

export type DraftInput = {
  readonly text: string;
  readonly selection: { readonly start: number; readonly end: number };
};

type HookInput = {
  /** The draft's own environment. Optional transcript cleanup runs there, never on the audio destination. */
  readonly environmentId: EnvironmentId;
  /** The draft's project: its vocabulary on that environment and its name become recognition hints. */
  readonly projectId?: ProjectId | null | undefined;
  readonly projectName?: string | null | undefined;
  readonly ownerKey: string;
  readonly disabled?: boolean | undefined;
  /**
   * Until a destination is chosen, voice input is offered and its first gesture opens Voice
   * settings. False hides it instead, for editors whose draft would not survive the navigation.
   */
  readonly offerSetup?: boolean | undefined;
  /** False keeps the transcript off the cleanup provider even when cleanup is on; the model test uses it. */
  readonly cleanup?: boolean | undefined;
  readonly readDraft: () => DraftInput;
  readonly commitDraft: (
    text: string,
    selection: { readonly start: number; readonly end: number },
  ) => void;
  /** Supplies cleanup's context when the text lands outside this draft, such as in another app. */
  readonly prepareCleanup?: (intent: SpeechPostProcessingIntent) => Promise<{
    readonly draft: DraftInput | null;
    readonly targetApp: string | null;
  }>;
  /** Reports why a spoken command produced no text; defaults to a toast. */
  readonly onCommandFailure?: (message: string) => void;
  /** Names the draft in the indicator shown while a recording's editor is off screen. */
  readonly label?: string | null | undefined;
  /** False while the editor stays mounted out of sight, so the indicator still shows. */
  readonly presented?: boolean | undefined;
  /**
   * A draft that is stored outside its editor keeps recording when the editor shows another
   * owner or unmounts; the transcript lands in the stored draft instead.
   */
  readonly persistentDraft?:
    | {
        readonly readStoredText: () => string | null;
        readonly commitStoredText: (text: string) => void;
        readonly open: () => void;
      }
    | undefined;
};

/** Why a spoken command can't run on the draft's environment, or null when it can. */
function commandBlocker(environment: {
  readonly supported: boolean;
  readonly reachable: boolean;
  readonly label: string | undefined;
}): string | null {
  const name = environment.label;
  if (!readCleanupGrant())
    return m(msg("Spoken commands use transcript cleanup. Turn it on in Voice settings."));
  if (!environment.supported)
    return name === undefined
      ? m(msg("This environment runs a T3 server without spoken commands. Update it to use them."))
      : m(msg("{name} runs a T3 server without spoken commands. Update it to use them.", { name }));
  if (!environment.reachable)
    return name === undefined
      ? m(msg("This environment isn't available for transcript cleanup right now."))
      : m(msg("{name} isn't available for transcript cleanup right now.", { name }));
  return null;
}

/**
 * Microphone audio leaves this device only for the environment the person chose in
 * Voice settings. Nothing is inferred from the primary or the draft's environment, and
 * the recording is abandoned the moment that choice changes or its connection drops.
 * Apple Speech ("device") keeps audio on this Mac and needs no environment.
 */
export function useVoiceTranscriptionDestination() {
  const gt = useGT();
  const hydrated = useClientSettingsHydrated();
  const choice = useAudioChoice();
  const grant = choice === "off" ? null : choice;
  const appleSpeechAvailable = useAppleSpeechLocales().length > 0;
  const device = hydrated && grant?.destination.kind === "device";
  const environmentId =
    hydrated && grant && grant.destination.kind !== "device"
      ? grant.destination.environmentId
      : null;
  const environment = useEnvironment(environmentId);
  const connection = Option.getOrNull(usePreparedConnection(environmentId));
  const canDictate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const cloud = grant?.destination.kind === "cloud" ? grant.destination : undefined;
  const provider = cloud?.provider;
  const model = cloud?.provider === "openrouter" ? cloud.model : undefined;
  const supported =
    environment?.serverConfig?.environment.capabilities[
      provider ? "cloudVoiceTranscription" : "voiceTranscription"
    ] === true;
  return {
    ...(hydrated && choice === null ? { offerFirstRunSetup: true } : {}),
    environmentId,
    ...(device ? { device: true, onDevice: appleSpeechAvailable } : {}),
    ...(provider ? { cloudProvider: provider } : {}),
    ...(model ? { cloudModel: model } : {}),
    grantId: grant?.id ?? null,
    label: device
      ? APPLE_SPEECH_LABEL
      : provider && environment
        ? gt("{provider} via {environment}", {
            provider: CLOUD_SPEECH_LABELS[provider],
            environment: environment.label,
          })
        : (environment?.label ?? null),
    prepared: supported && canDictate ? connection : null,
  };
}

function reportCommandFailure(message: string) {
  toastManager.add({ type: "warning", title: m(msg("Spoken command")), description: message });
}

export function useEnvironmentSpeechInput(input: HookInput) {
  const navigate = useNavigate();
  const destination = useVoiceTranscriptionDestination();
  const prepared = destination.prepared;
  const onDevice = destination.onDevice === true;
  const grantId = destination.grantId;
  const cloudProvider = destination.cloudProvider;
  const cloudModel = destination.cloudModel;
  const draftEnvironment = useEnvironment(input.environmentId);
  const draftCapabilities = draftEnvironment?.serverConfig?.environment.capabilities;
  const originatingConnection = Option.getOrNull(usePreparedConnection(input.environmentId));
  const canCleanUp = useEnvironmentScope(input.environmentId, AuthOrchestrationOperateScope);
  const cleanupPrepared =
    canCleanUp &&
    (draftCapabilities?.voiceTranscription || draftCapabilities?.cloudVoiceTranscription)
      ? originatingConnection
      : null;
  const clientSettings = useClientSettings();
  const projectId = input.projectId ?? null;
  const projectWords = useEnvironmentSettings(
    input.environmentId,
    (settings) => resolveProjectSettings(settings, projectId).settings.speechProjectCustomWords,
  );
  const [status, setStatus] = useState<{
    readonly prepared: PreparedConnection;
    readonly value: EnvironmentSpeechStatus | null;
  } | null>(null);
  const [setup, setSetup] = useState(INITIAL_SETUP);
  const [previousDestination, setPreviousDestination] = useState({ prepared, grantId });
  const [previousOwner, setPreviousOwner] = useState({
    key: input.ownerKey,
    disabled: input.disabled,
  });
  if (previousDestination.prepared !== prepared || previousDestination.grantId !== grantId) {
    setPreviousDestination({ prepared, grantId });
    setSetup(INITIAL_SETUP);
  }
  if (previousOwner.key !== input.ownerKey || previousOwner.disabled !== input.disabled) {
    setPreviousOwner({ key: input.ownerKey, disabled: input.disabled });
    setSetup(INITIAL_SETUP);
  }

  const session = useRetainedVoiceInputSession({
    prepared,
    grantId,
    onDevice,
    cloudProvider,
    cloudModel,
  });
  const snapshot = useVoiceInputSessionSnapshot(session);
  const owns = snapshot.target?.ownerKey === input.ownerKey;
  const activity = useVoiceInputSessionActivity(session, input.ownerKey);
  const state = owns ? snapshot.state : IDLE_VOICE_STATE;
  // One microphone: another draft's recording leaves this editor without voice input until it ends.
  const busyElsewhere = !owns && voiceInputBlocksSubmission(snapshot.state);

  const intentRef = useRef<SpeechPostProcessingIntent>("dictate");
  const [recordingIntent, setRecordingIntent] = useState<SpeechPostProcessingIntent>("dictate");
  const startRequestRef = useRef(0);
  const commandEnvironment = {
    supported: draftCapabilities?.voiceCommands === true,
    reachable: cleanupPrepared !== null,
    label: draftEnvironment?.label,
  };
  const latestRef = useRef({
    input,
    clientSettings,
    cleanupPrepared,
    projectWords,
    commandEnvironment,
    session,
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes committed props before an async completion can read them through the session
  useLayoutEffect(() => {
    latestRef.current = {
      input,
      clientSettings,
      cleanupPrepared,
      projectWords,
      commandEnvironment,
      session,
    };
  });
  const mountedRef = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- abandons this editor's pending work, and a recording that cannot outlive it, on unmount or a destination change
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      startRequestRef.current += 1;
      session?.ownerChanged(latestRef.current.input.ownerKey);
    };
  }, [session]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the global indicator this draft is on screen
  useEffect(
    () => (input.presented === false ? undefined : presentVoiceOwner(input.ownerKey)),
    [input.ownerKey, input.presented],
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- probes the chosen environment's speech status once its connection is available
  useEffect(() => {
    if (!prepared || cloudProvider) return;
    let disposed = false;
    void probeSpeechStatus(prepared)
      .then((value) => {
        if (!disposed) setStatus({ prepared, value });
      })
      .catch(() => {
        if (!disposed) setStatus({ prepared, value: null });
      });
    return () => {
      disposed = true;
    };
  }, [prepared, cloudProvider]);
  const currentStatus = !cloudProvider && status?.prepared === prepared ? status.value : null;
  const setupModelId = setup.model?.id;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls download progress while the setup dialog owns an active model download
  useEffect(() => {
    if (!setup.open || !setup.downloading || !prepared || !setupModelId) return;
    let disposed = false;
    let refreshing = false;
    const timer = window.setInterval(() => {
      if (refreshing) return;
      refreshing = true;
      void runEnvironmentSpeech(getEnvironmentSpeechModels(prepared))
        .then((result) => {
          if (disposed) return;
          const model = result.models.find((candidate) => candidate.id === setupModelId) ?? null;
          if (model)
            setSetup((current) => ({
              ...current,
              model: { ...model, recommended: current.model?.recommended ?? false },
            }));
        })
        .catch(() => undefined)
        .finally(() => {
          refreshing = false;
        });
    }, 1_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [prepared, setup.downloading, setup.open, setupModelId]);

  const previousOwnerRef = useRef(input.ownerKey);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- abandons a recording that cannot outlive its editor when the draft's owner changes
  useEffect(() => {
    const previous = previousOwnerRef.current;
    if (previous === input.ownerKey && !input.disabled) return;
    previousOwnerRef.current = input.ownerKey;
    startRequestRef.current += 1;
    if (previous !== input.ownerKey) session?.ownerChanged(previous);
    else if (session?.ownerKey === input.ownerKey) session.cancel();
  }, [input.ownerKey, input.disabled, session]);

  const submitAfterDictation = useStableCallback((submit: (text: string) => void) => {
    if (latestRef.current.input.disabled || state.phase === "preparing") return;
    if (!session || !voiceInputBlocksSubmission(state)) {
      submit(latestRef.current.input.readDraft().text);
      return;
    }
    session.queueSubmission(latestRef.current.input.ownerKey, submit);
  });

  const createTarget = useStableCallback((): VoiceInputTarget => {
    const owner = latestRef.current.input.ownerKey;
    const readContext = () => {
      const current = latestRef.current;
      return {
        environmentId: current.input.environmentId,
        projectName: current.input.projectName ?? null,
        projectWords: current.projectWords,
        clientSettings: current.clientSettings,
        cleanup: current.input.cleanup !== false,
        cleanupPrepared: current.cleanupPrepared,
      };
    };
    // Once this editor shows another draft, its environment and cleanup must not see this one.
    const startContext = readContext();
    const persistent = latestRef.current.input.persistentDraft ?? null;
    // While this editor shows the owner, the live editor is the draft; otherwise the stored one.
    const live = () => mountedRef.current && latestRef.current.input.ownerKey === owner;
    return {
      ownerKey: owner,
      label: latestRef.current.input.label ?? null,
      persistent: persistent !== null,
      open: persistent?.open ?? null,
      readDraft: () => {
        if (live()) return latestRef.current.input.readDraft();
        const text = persistent?.readStoredText();
        return text == null ? null : { text, selection: { start: text.length, end: text.length } };
      },
      commitDraft: (text, selection) => {
        if (!live()) {
          persistent?.commitStoredText(text);
          return;
        }
        if (latestRef.current.input.disabled) return;
        latestRef.current.input.commitDraft(text, selection);
      },
      readContext: () => (live() ? readContext() : startContext),
      postProcessing: {
        intent: () => intentRef.current,
        prepareCleanup: (intent) =>
          latestRef.current.input.prepareCleanup?.(intent) ?? Promise.resolve(null),
        commandBlocker: () => commandBlocker(latestRef.current.commandEnvironment),
        onCommandFailure: (message) =>
          (latestRef.current.input.onCommandFailure ?? reportCommandFailure)(message),
      },
    };
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a remounted editor takes over its draft's running recording so a queued Send still sees the transcript
  useEffect(() => {
    if (session?.ownerKey === input.ownerKey && voiceInputBlocksSubmission(session.state))
      session.adopt(createTarget());
  }, [session, input.ownerKey, createTarget]);
  const loadSetupCatalog = useStableCallback(
    async (
      connection: PreparedConnection,
      selectedModelId: string,
      benchmarkTier: SpeechBenchmarkTier,
      request: number,
    ) => {
      setSetup({ ...INITIAL_SETUP, open: true });
      const catalog = await runEnvironmentSpeech(
        getEnvironmentSpeechModels(connection, true),
      ).catch(() => null);
      if (request !== startRequestRef.current) return;
      const choice = chooseSetupSpeechModel(catalog?.models ?? [], {
        selectedModelId,
        intent: latestRef.current.clientSettings.speechLanguage,
        preferred: preferredSpeechLanguages(),
        benchmarkTier,
      });
      setSetup((current) => ({
        ...current,
        model: choice ? { ...choice.model, recommended: choice.recommended } : null,
        language: choice?.language ?? null,
        catalogFailed: catalog === null,
        error: choice
          ? null
          : catalog
            ? m(
                msg(
                  "No model matches your language. Choose a model or change the language in Voice settings.",
                ),
              )
            : m(msg("Could not load transcription models. Check the connection and try again.")),
      }));
    },
  );

  const start = useStableCallback(
    async (options?: { readonly intent?: SpeechPostProcessingIntent }) => {
      if (latestRef.current.input.disabled || (setup.open && setup.downloading)) return;
      const intent = options?.intent ?? "dictate";
      const blocked = intent === "command" ? commandBlocker(commandEnvironment) : null;
      if (blocked) {
        (latestRef.current.input.onCommandFailure ?? reportCommandFailure)(blocked);
        return;
      }
      intentRef.current = intent;
      setRecordingIntent(intent);
      if (!grantId) {
        if (destination.offerFirstRunSetup && latestRef.current.input.offerSetup !== false)
          await navigate({ to: "/settings/voice", hash: "voice-transcription-destination" });
        return;
      }
      if (!session || voiceInputBlocksSubmission(session.state)) return;
      const request = ++startRequestRef.current;
      const owner = latestRef.current.input.ownerKey;
      if (onDevice) {
        await session.start(createTarget());
        return;
      }
      if (!prepared) return;
      if (cloudProvider) {
        await session.start(createTarget());
        return;
      }
      setSetup(INITIAL_SETUP);
      const stillCurrent = () =>
        request === startRequestRef.current &&
        latestRef.current.session === session &&
        latestRef.current.input.ownerKey === owner &&
        !latestRef.current.input.disabled;
      const handleStatus = async (latestStatus: EnvironmentSpeechStatus) => {
        if (!stillCurrent()) return;
        setStatus({ prepared, value: latestStatus });
        if (!latestStatus.supported) {
          session.cancel();
          toastManager.add({
            type: "error",
            title: m(msg("Voice input is not available")),
            description: latestStatus.reason,
          });
        } else if (latestStatus.state === "missing-model") {
          session.cancel();
          await loadSetupCatalog(
            prepared,
            latestStatus.modelId,
            latestStatus.benchmarkTier,
            request,
          );
        }
      };

      if (currentStatus?.supported && currentStatus.state === "missing-model") {
        // Setup must remain usable without opening the microphone.
        const latestStatus = await probeSpeechStatus(prepared, true).catch((error: unknown) => {
          if (stillCurrent()) {
            toastManager.add({
              type: "error",
              title: m(msg("Could not start voice input")),
              description: error instanceof Error ? error.message : String(error),
            });
          }
          return null;
        });
        if (!stillCurrent() || !latestStatus) return;
        await handleStatus(latestStatus);
        if (!latestStatus.supported || latestStatus.state === "missing-model" || !stillCurrent())
          return;
      }

      await session.start(createTarget(), (latestStatus) => void handleStatus(latestStatus));
    },
  );

  const downloadSetupModel = useStableCallback(async () => {
    if (!prepared || !currentStatus?.supported || !setupModelId || setup.downloading) return;
    const modelId = setupModelId;
    const request = ++startRequestRef.current;
    setSetup((current) => ({ ...current, downloading: true, error: null }));
    try {
      const downloaded = await runEnvironmentSpeech(
        downloadEnvironmentSpeechModel(prepared, modelId),
      );
      if (request !== startRequestRef.current) return;
      const outcome = getSpeechModelDownloadOutcome(downloaded, modelId);
      if (outcome === "needs-selection") {
        try {
          await runEnvironmentSpeech(selectEnvironmentSpeechModel(prepared, modelId));
        } catch {
          if (request !== startRequestRef.current) return;
          setSetup((current) => ({
            ...current,
            downloading: false,
            error: m(
              msg("The model downloaded, but this environment could not select it. Try again."),
            ),
          }));
          return;
        }
      }
      if (request !== startRequestRef.current) return;
      const next = await probeSpeechStatus(prepared, true);
      if (request !== startRequestRef.current) return;
      setStatus({ prepared, value: next });
      const ready =
        outcome !== "incomplete" &&
        next.supported &&
        next.modelId === modelId &&
        next.state !== "missing-model";
      setSetup((current) => ({
        ...current,
        downloading: false,
        step: ready ? 1 : current.step,
        error: ready ? null : m(msg("The model is not ready. Try downloading it again.")),
      }));
    } catch {
      if (request !== startRequestRef.current) return;
      setSetup((current) => ({
        ...current,
        downloading: false,
        error: m(
          msg("Could not download the model. Check this environment's connection and try again."),
        ),
      }));
    }
  });

  const cancelSetupDownload = useStableCallback(async () => {
    if (!prepared || !setupModelId) return;
    startRequestRef.current += 1;
    setSetup((current) => ({ ...current, open: false, downloading: false }));
    try {
      await runEnvironmentSpeech(cancelEnvironmentSpeechModelDownload(prepared, setupModelId));
    } catch (error) {
      setSetup((current) => ({
        ...current,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  });

  const ownerKey = input.ownerKey;
  const recordingActive = voiceInputBlocksSubmission(state);
  const recordingLevel = Math.round(activity.level * 10) / 10;
  const previewText =
    activity.preview && (state.phase === "recording" || state.phase === "transcribing")
      ? `${activity.preview.committed}${activity.preview.tentative}`
      : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors this editor's recording into the store the desktop pill reads, outside React
  useEffect(() => {
    publishRecording(
      ownerKey,
      recordingActive
        ? {
            ownerKey,
            phase: state.phase,
            gesture: recordingIntent === "command" ? "command" : "dictate",
            level: recordingLevel,
            preview: previewText,
          }
        : null,
    );
  }, [ownerKey, recordingActive, state.phase, recordingIntent, recordingLevel, previewText]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- an editor that unmounts mid-recording leaves no stale entry behind
  useEffect(() => () => publishRecording(ownerKey, null), [ownerKey]);

  const destinationReady =
    grantId === null
      ? Boolean(destination.offerFirstRunSetup) && input.offerSetup !== false
      : onDevice ||
        (prepared !== null &&
          (cloudProvider !== undefined ||
            (status?.prepared === prepared && status.value?.supported !== false)));
  return {
    available:
      destinationReady &&
      !busyElsewhere &&
      typeof navigator !== "undefined" &&
      Boolean(navigator.mediaDevices?.getUserMedia) &&
      typeof AudioWorkletNode !== "undefined",
    status: currentStatus,
    transcriptionEnvironmentId: destination.environmentId,
    transcriptionEnvironmentLabel: destination.label,
    setup: {
      ...setup,
      setOpen: (open: boolean) => setSetup((current) => ({ ...current, open })),
      retryCatalog:
        setup.open && setup.catalogFailed && prepared && currentStatus?.supported
          ? () =>
              loadSetupCatalog(
                prepared,
                currentStatus.modelId,
                currentStatus.benchmarkTier,
                ++startRequestRef.current,
              )
          : null,
      download: downloadSetupModel,
      cancelDownload: cancelSetupDownload,
      startRecording: async () => {
        setSetup((current) => ({ ...current, open: false }));
        // A spoken command that waited for its model must still run as a command.
        await start({ intent: intentRef.current });
      },
    },
    state,
    preview:
      state.phase === "recording" || state.phase === "transcribing" ? activity.preview : null,
    level: activity.level,
    recordingStartedAt: owns ? snapshot.recordingStartedAt : null,
    preparing: state.phase === "preparing",
    blocksSubmission: voiceInputBlocksSubmission(state),
    freezesEditor: voiceInputBlocksSubmission(state),
    start,
    /** Changes what a running recording becomes, for a modifier added during a held key. */
    retarget: useStableCallback((intent: SpeechPostProcessingIntent) => {
      intentRef.current = intent;
      setRecordingIntent(intent);
    }),
    submitAfterDictation,
    stop: useStableCallback(() => (owns && session ? session.stop() : Promise.resolve())),
    cancel: useStableCallback(() => {
      startRequestRef.current += 1;
      setSetup(INITIAL_SETUP);
      if (owns) session?.cancel();
    }),
    // A command's raw transcript is the instruction itself, so skipping its cleanup discards it.
    skipPostProcessing: useStableCallback(() => {
      if (!owns) return;
      if (intentRef.current === "command") session?.cancel();
      else session?.skipPostProcessing();
    }),
  };
}
