import { useAtomValue } from "@effect/atom-react";
import {
  useNavigation,
  usePreventRemove,
  useRoute,
  type StaticScreenProps,
} from "@react-navigation/native";
import { captureHome } from "@t3tools/client-runtime/state/follow-ups";
import type { EnvironmentId, FollowUpOrigin } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import * as Haptics from "expo-haptics";
import { useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";

import type { ComposerEditorSelection } from "../../components/ComposerEditor";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Chip } from "../../components/ui/Chip";
import * as Dialog from "../../components/ui/Dialog";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  environmentFollowUpHomeAtom,
  followUpEnvironment,
  followUpHomesAtom,
} from "../../state/follow-ups";
import { connectedEnvironmentIdsAtom } from "../../state/presentation";
import { useAtomCommand } from "../../state/use-atom-command";
import { useWorkspaceEnvironments } from "../../state/workspace";
import {
  ComposerDictationCancelAction,
  ComposerDictationError,
  ComposerDictationPrimaryAction,
  ComposerDictationStartAction,
  ComposerDictationStatus,
  ComposerDictationToolbar,
} from "../voice-input/ComposerDictationControl";
import { useVoiceInputController } from "../voice-input/useVoiceInputController";
import { resolveVoiceComposerPresentation } from "../voice-input/voiceInputPresentation";
import {
  captureOriginFromParams,
  followUpCaptureInput,
  type FollowUpCaptureParams,
} from "./followUpCapture";
import { failureMessage } from "./useStartFollowUpThread";

/** Writes a follow-up down quickly, by keyboard or voice, or from a quote in a thread. */
export function FollowUpCaptureRouteScreen({
  route,
}: StaticScreenProps<FollowUpCaptureParams | undefined>) {
  const origin = captureOriginFromParams(route.params);
  // The route keeps its component when another quote opens it, so start fresh then.
  return (
    <FollowUpCapture
      key={origin === null ? "note" : `${origin.messageId}\n${origin.quote}`}
      origin={origin}
    />
  );
}

const noHomeAtom = Atom.make<EnvironmentId | null>(null).pipe(
  Atom.withLabel("mobile:follow-up-capture:no-home"),
);

function FollowUpCapture(props: { readonly origin: FollowUpOrigin | null }) {
  const { origin } = props;
  const navigation = useNavigation();
  const routeKey = useRoute().key;
  const environments = useWorkspaceEnvironments();
  const label = (environmentId: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === environmentId)
      ?.environmentLabel ?? environmentId;

  const homes = useAtomValue(followUpHomesAtom);
  const connectedHomes = homes.filter((home) => home.connected);
  const connected = useAtomValue(connectedEnvironmentIdsAtom);
  const threadHome = useAtomValue(
    origin === null ? noHomeAtom : environmentFollowUpHomeAtom(origin.environmentId),
  );
  const [picked, setPicked] = useState<EnvironmentId | null>(null);
  // A quote goes to its thread's home; a note to the one home in reach, else the one picked.
  const destination =
    origin !== null
      ? threadHome !== null && connected.includes(threadHome)
        ? threadHome
        : null
      : (captureHome(homes)?.environmentId ??
        connectedHomes.find((home) => home.environmentId === picked)?.environmentId ??
        null);
  const canSave = useAtomValue(followUpEnvironment.save.permissionAtom(destination));

  // An atom, so dictation that finishes after a re-render still reads and writes the live text.
  const [textAtom] = useState(() => Atom.make(""));
  const text = useAtomValue(textAtom);
  const setText = (next: string) => appAtomRegistry.set(textAtom, next);
  const [editedSelection, setSelection] = useState<ComposerEditorSelection | null>(null);
  const selection = editedSelection ?? { start: text.length, end: text.length };
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const saved = useRef(false);
  const voice = useVoiceInputController({
    ownerKey: `follow-up-capture:${routeKey}`,
    label: "New follow-up",
    readDraftMessage: () => appAtomRegistry.get(textAtom),
    subscribeToDraftChanges: (onChange) => appAtomRegistry.subscribe(textAtom, onChange),
    selection,
    onChangeDraftMessage: setText,
    onChangeSelection: setSelection,
    disabled: saving,
  });
  const presentation = resolveVoiceComposerPresentation(voice.state, voice.elapsedSeconds);
  const dictating = presentation.statusKind === "active";

  const input = followUpCaptureInput(text, origin);
  const ready = input !== null && destination !== null && canSave && !voice.blocksSubmission;
  const saveCommand = useAtomCommand(followUpEnvironment.save, {
    label: "follow-up capture",
    reportFailure: false,
  });
  const save = async () => {
    if (!ready || input === null || destination === null || inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    const result = await saveCommand({ environmentId: destination, input });
    inFlight.current = false;
    setSaving(false);
    const message = failureMessage(result);
    if (message !== null) Dialog.alert("Could not save the follow-up", message);
    if (result._tag !== "Success") return;
    saved.current = true;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    navigation.goBack();
  };

  usePreventRemove(text.trim() !== "" || saving || voice.isBusy, ({ data }) => {
    if (saved.current) {
      navigation.dispatch(data.action);
      return;
    }
    if (saving) return;
    Dialog.confirm({
      title: "Discard this follow-up?",
      message: "What you wrote or dictated will be lost.",
      confirmText: "Discard",
      cancelText: "Keep editing",
      destructive: true,
      onConfirm: () => {
        if (voice.isBusy) voice.cancel();
        navigation.dispatch(data.action);
      },
    });
  });

  const notice =
    origin !== null
      ? threadHome === null
        ? "This thread's environment keeps no follow-ups."
        : destination === null
          ? `${label(threadHome)} keeps this thread's follow-ups but isn't connected.`
          : null
      : connectedHomes.length === 0
        ? "No connected environment keeps follow-ups."
        : null;
  const picking = origin === null && connectedHomes.length > 1;
  const destinationNotice =
    destination === null
      ? null
      : !canSave
        ? `This device may not add follow-ups on ${label(destination)}.`
        : homes.length > 1 && !picking
          ? `Saves to ${label(destination)}.`
          : null;

  return (
    <View className="flex-1 bg-sheet">
      <SheetHeader
        title="New follow-up"
        onCancel={() => navigation.goBack()}
        confirm={{
          label: "Save",
          onPress: () => void save(),
          disabled: !ready,
          loading: saving,
        }}
      />
      <KeyboardAvoidingView automaticOffset behavior="padding" className="flex-1">
        <ScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 20 }}
        >
          <View className="gap-4">
            {origin !== null ? (
              <View className="gap-1.5 px-1">
                <Text textRole="footnote" className="text-foreground-muted" numberOfLines={1}>
                  From {origin.threadTitle ?? "a thread"}
                </Text>
                <View className="border-l-2 border-border pl-3">
                  <Text textRole="body" selectable className="text-foreground" numberOfLines={8}>
                    {origin.quote}
                  </Text>
                </View>
              </View>
            ) : null}
            {picking ? (
              <View className="gap-2 px-1">
                <Text textRole="footnote" className="text-foreground-muted">
                  Save it to
                </Text>
                <View className="flex-row flex-wrap gap-2">
                  {connectedHomes.map((home) => (
                    <Chip
                      key={home.environmentId}
                      label={label(home.environmentId)}
                      selected={home.environmentId === destination}
                      disabled={saving}
                      onPress={() => setPicked(home.environmentId)}
                    />
                  ))}
                </View>
              </View>
            ) : null}
            <View className="gap-2 rounded-[20px] bg-grouped-card px-4 py-3">
              <View className="flex-row items-start">
                <TextInput
                  autoFocus
                  multiline
                  scrollEnabled
                  accessibilityLabel={origin === null ? "Follow-up" : "Title"}
                  placeholder={origin === null ? "What's worth doing later?" : "Title (optional)"}
                  placeholderTextColorClassName="accent-foreground-muted"
                  value={text}
                  onChangeText={setText}
                  selection={selection}
                  onSelectionChange={({ nativeEvent }) => setSelection(nativeEvent.selection)}
                  readOnly={saving || voice.freezesEditor}
                  textAlignVertical="top"
                  className="max-h-64 min-h-28 min-w-0 flex-1 font-sans text-base text-foreground"
                />
                {voice.isAvailable && !dictating ? (
                  <ComposerDictationStartAction
                    size="large"
                    state={voice.state}
                    isAvailable={voice.isAvailable}
                    disabled={saving}
                    onStart={voice.start}
                    onCancel={voice.cancel}
                  />
                ) : null}
              </View>
              <ComposerDictationError
                error={voice.state.phase === "error" ? voice.state.error : null}
                onDismiss={voice.cancel}
              />
              {dictating ? (
                <ComposerDictationToolbar showsDictation>
                  <View className="h-11 flex-row items-center">
                    <ComposerDictationCancelAction
                      presentation={presentation}
                      onCancel={voice.cancel}
                    />
                    <ComposerDictationStatus
                      audioLevels={voice.audioLevels}
                      elapsedSeconds={voice.elapsedSeconds}
                      phase={voice.state.phase}
                      presentation={presentation}
                    />
                    <ComposerDictationPrimaryAction
                      state={voice.state}
                      presentation={presentation}
                      isAvailable={voice.isAvailable}
                      disabled={saving}
                      onStart={voice.start}
                      onConfirm={voice.stop}
                      onCancel={voice.cancel}
                    />
                  </View>
                </ComposerDictationToolbar>
              ) : null}
            </View>
            {(notice ?? destinationNotice) ? (
              <Text textRole="footnote" className="px-1 text-foreground-muted">
                {notice ?? destinationNotice}
              </Text>
            ) : null}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}
