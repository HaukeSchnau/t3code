import { isFollowUpClosed } from "@t3tools/client-runtime/state/follow-ups";
import { useAtomValue } from "@effect/atom-react";
import { DateTimePicker } from "@expo/ui/community/datetime-picker";
import type { MenuAction } from "@react-native-menu/menu";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  pickSnoozePreset,
  resolveSnoozePresets,
} from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  FollowUpId,
  ThreadId,
  type FollowUp,
  type FollowUpLink,
  type FollowUpSaveInput,
} from "@t3tools/contracts";
import { parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ListRow } from "../../components/ui/ListRow";
import { Menu } from "../../components/ui/Menu";
import { AppText as Text } from "../../components/ui/AppText";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useNowMinuteMs } from "../../lib/clock";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import {
  useLiveThreadLinkLabels,
  useProject,
  useProjects,
  useThreadShell,
} from "../../state/entities";
import { allFollowUpsAtom, followUpEnvironment, openFollowUpsAtom } from "../../state/follow-ups";
import { connectedEnvironmentIdsAtom } from "../../state/presentation";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import {
  FOLLOW_UP_LATER_PRESETS,
  FOLLOW_UP_STATUS_LABELS,
  followUpActorLabel,
  followUpFieldValue,
  formatFollowUpDate,
} from "./followUpPresentation";
import { failureMessage, useStartFollowUpThread } from "./useStartFollowUpThread";

type FollowUpRouteParams = {
  /** The home environment that keeps it. */
  readonly environmentId: string;
  readonly followUpId: string;
};

export function FollowUpRouteScreen({ route }: StaticScreenProps<FollowUpRouteParams>) {
  const { environmentId, followUpId } = route.params;
  // The route keeps its component when a link opens another follow-up, so start fresh then.
  return (
    <FollowUpScreen
      key={`${environmentId}\n${followUpId}`}
      homeEnvironmentId={EnvironmentId.make(environmentId)}
      followUpId={FollowUpId.make(followUpId)}
    />
  );
}

type ThreadRef = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

/** Opens a thread the way the thread list does, so it sits above the tab bar as a chat. */
function useOpenThread() {
  const selectDetail = useSelectWorkspaceDetail();
  return (ref: ThreadRef) =>
    selectDetail({
      name: "Thread",
      params: { environmentId: String(ref.environmentId), threadId: String(ref.threadId) },
    });
}

function FollowUpScreen(props: {
  readonly homeEnvironmentId: EnvironmentId;
  readonly followUpId: FollowUpId;
}) {
  const home = props.homeEnvironmentId;
  const insets = useSafeAreaInsets();
  const open = useEnvironmentQuery(openFollowUpsAtom(home));
  const openMatch = open.data?.followUps.find((followUp) => followUp.id === props.followUpId);
  // Closed ones only come with the closed list; ask for it once the open list lacks this one.
  const all = useEnvironmentQuery(
    open.data !== null && openMatch === undefined ? allFollowUpsAtom(home) : null,
  );
  const match =
    openMatch ?? all.data?.followUps.find((followUp) => followUp.id === props.followUpId);
  // A close drops it from the open list before the closed list arrives; keep showing the save.
  const [shown, setShown] = useState<FollowUp | null>(null);
  if (match !== undefined && match !== shown) setShown(match);
  const followUp = match ?? shown;
  const error = open.error ?? all.error;

  return (
    <SettingsScreen title="Follow-up">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {followUp !== null ? (
          <FollowUpDetail
            homeEnvironmentId={home}
            followUp={followUp}
            known={[...(open.data?.followUps ?? []), ...(all.data?.followUps ?? [])]}
            onSaved={setShown}
          />
        ) : (
          <Text className="px-2 text-base text-foreground-muted">
            {error ??
              (open.data !== null && all.data !== null
                ? "This follow-up is not in its environment's list."
                : "Loading follow-up…")}
          </Text>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

function FollowUpDetail(props: {
  readonly homeEnvironmentId: EnvironmentId;
  readonly followUp: FollowUp;
  /** Follow-ups loaded from the same home, to name linked ones. */
  readonly known: ReadonlyArray<FollowUp>;
  readonly onSaved: (followUp: FollowUp) => void;
}) {
  const { followUp, homeEnvironmentId: home } = props;
  const navigation = useNavigation();
  const openThread = useOpenThread();
  const history = useEnvironmentQuery(
    followUpEnvironment.history({ environmentId: home, input: { id: followUp.id } }),
  );
  const refreshHistory = useEffectEvent(() => history.refresh());
  const updatedAt = followUp.updatedAt;
  // A first read is already loading; a cached one is current when it ends with this change.
  const seenUpdatedAt = useRef(history.data === null ? updatedAt : history.data.changes.at(-1)?.at);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refetches the server's change log when the subscribed follow-up changes
  useEffect(() => {
    if (seenUpdatedAt.current === updatedAt) return;
    seenUpdatedAt.current = updatedAt;
    refreshHistory();
  }, [updatedAt]);
  const canSave = useAtomValue(followUpEnvironment.save.permissionAtom(home));
  const saveCommand = useAtomCommand(followUpEnvironment.save, {
    label: "follow-up save",
    reportFailure: false,
  });
  const [saving, setSaving] = useState(false);
  const save = async (failureTitle: string, patch: Omit<FollowUpSaveInput, "id">) => {
    if (saving) return;
    setSaving(true);
    const result = await saveCommand({
      environmentId: home,
      input: { id: followUp.id, ...patch },
    });
    setSaving(false);
    if (result._tag === "Success") props.onSaved(result.value);
    const message = failureMessage(result);
    if (message !== null) Dialog.alert(failureTitle, message);
  };
  const { start, starting } = useStartFollowUpThread({
    homeEnvironmentId: home,
    followUp,
    onSaved: props.onSaved,
    onStarted: openThread,
  });

  const origin = followUp.origin;
  const originShell = useThreadShell(
    origin === null ? null : { environmentId: origin.environmentId, threadId: origin.threadId },
  );
  const originProject = useProject(
    originShell === null
      ? null
      : { environmentId: originShell.environmentId, projectId: originShell.projectId },
  );
  const pickedUpShell = useThreadShell(followUp.pickedUpThread);
  const markdownStyles = useMarkdownPreviewStyles();
  const body = useLiveThreadLinkLabels(followUp.body, origin?.environmentId ?? home);
  const openPullRequest = useOpenPullRequest();
  const openLink = (href: string) => {
    const link = parseThreadLinkHref(href);
    if (link === null) {
      void openPullRequest(href);
      return;
    }
    openThread({
      environmentId: link.environmentId ?? origin?.environmentId ?? home,
      threadId: link.threadId,
    });
  };
  const openFollowUp = (id: FollowUpId) =>
    navigation.dispatch(
      StackActions.push("FollowUp", { environmentId: String(home), followUpId: String(id) }),
    );

  const closed = isFollowUpClosed(followUp);
  const markDone = () =>
    Dialog.prompt({
      title: "Mark as done",
      message: "Add the result, if there is one.",
      placeholder: "Result",
      initialValue: "",
      confirmText: "Done",
      onConfirm: (result) =>
        void save("Could not mark it done", {
          status: "done",
          ...(result.trim() === "" ? {} : { result: result.trim() }),
        }),
    });
  const drop = () =>
    Dialog.confirm({
      title: "Drop this follow-up?",
      message: followUp.title,
      confirmText: "Drop",
      destructive: true,
      onConfirm: () => void save("Could not drop it", { status: "dropped" }),
    });
  const reopen = () =>
    void save("Could not reopen it", {
      status: "open",
      ...(followUp.status === "picked_up" ? { pickedUpThread: null } : {}),
      ...(followUp.status === "merged" ? { mergedInto: null } : {}),
    });

  const fieldRows = Object.entries(followUp.fields);
  const links: ReadonlyArray<FollowUpLink> = [
    ...(followUp.mergedInto === null
      ? []
      : [
          {
            kind: "merged into",
            target: { type: "followUp" as const, followUpId: followUp.mergedInto },
          },
        ]),
    ...followUp.links,
  ];

  return (
    <>
      <View className="gap-2 px-2">
        <Text textRole="title" className="font-t3-bold text-foreground">
          {followUp.title}
        </Text>
        <Text textRole="footnote" className="text-foreground-muted">
          {[
            FOLLOW_UP_STATUS_LABELS[followUp.status],
            followUp.returnedAt !== null && followUp.status === "open"
              ? `back since ${formatFollowUpDate(followUp.returnedAt)}`
              : null,
            followUp.type,
            ...followUp.tags.map((tag) => `#${tag}`),
          ]
            .filter((part): part is string => part !== null)
            .join(" · ")}
        </Text>
      </View>

      {closed ? (
        <View className="flex-row flex-wrap gap-2 px-2">
          <Button
            label="Reopen"
            icon="arrow.uturn.backward"
            disabled={!canSave}
            loading={saving}
            onPress={reopen}
          />
        </View>
      ) : (
        <View className="flex-row flex-wrap gap-2 px-2">
          {followUp.status === "open" ? (
            <StartThreadButton
              originProject={originProject}
              preferredEnvironmentId={origin?.environmentId ?? null}
              disabled={!canSave || saving}
              starting={starting}
              onStart={start}
            />
          ) : null}
          <Button
            label="Done"
            icon="checkmark"
            disabled={!canSave || starting}
            loading={saving}
            onPress={markDone}
          />
          {followUp.status === "open" ? (
            <LaterButton
              followUp={followUp}
              disabled={!canSave || saving || starting}
              onReschedule={(dueAt) => void save("Could not move its date", { dueAt })}
            />
          ) : (
            <Button
              label="Reopen"
              icon="arrow.uturn.backward"
              disabled={!canSave || saving}
              onPress={reopen}
            />
          )}
          <Button
            label="Drop"
            icon="xmark"
            tone="danger"
            disabled={!canSave || saving || starting}
            onPress={drop}
          />
        </View>
      )}

      {followUp.body.trim() !== "" ? (
        <View className="px-2">
          <SelectableMarkdownText
            markdown={body}
            textStyle={markdownStyles.nativeTextStyle}
            onLinkPress={openLink}
          />
        </View>
      ) : null}

      {followUp.result !== null ? (
        <SettingsSection title="Result">
          <Text textRole="body" selectable className="px-4 py-3 text-foreground">
            {followUp.result}
          </Text>
        </SettingsSection>
      ) : null}

      <SettingsSection title="Came from">
        {origin === null ? (
          <Text textRole="body" className="px-4 py-3 text-foreground-muted">
            {followUp.createdBy.kind === "user"
              ? "You added it."
              : `${followUpActorLabel(followUp.createdBy)} added it outside a thread.`}
          </Text>
        ) : (
          <>
            <ListRow
              icon="text.bubble"
              label={origin.threadTitle ?? originShell?.title ?? "Thread"}
              description={formatFollowUpDate(followUp.createdAt)}
              onPress={() => openThread(origin)}
            />
            {origin.quote !== null ? (
              <View className="border-t border-border-subtle px-4 py-3">
                <View className="border-l-2 border-border pl-3">
                  <Text textRole="footnote" selectable className="text-foreground-muted">
                    {origin.quote}
                  </Text>
                </View>
              </View>
            ) : null}
          </>
        )}
      </SettingsSection>

      <SettingsSection title="Details">
        <DetailRow
          first
          label={followUp.dueAt !== null ? "Comes back" : "Comes back when"}
          value={
            followUp.dueAt !== null
              ? formatFollowUpDate(followUp.dueAt)
              : (followUp.condition ?? "No date")
          }
        />
        <DetailRow label="Type" value={followUp.type ?? "None"} />
        {fieldRows.map(([name, value]) => (
          <DetailRow key={name} label={name} value={followUpFieldValue(value)} />
        ))}
        <DetailRow
          label="Tags"
          value={followUp.tags.length > 0 ? followUp.tags.join(", ") : "None"}
        />
        {followUp.closedAt !== null ? (
          <DetailRow label="Closed" value={formatFollowUpDate(followUp.closedAt)} />
        ) : null}
      </SettingsSection>

      {followUp.pickedUpThread !== null ? (
        <SettingsSection title="Picked up by">
          <ListRow
            icon="text.bubble"
            label={pickedUpShell?.title ?? "Thread"}
            onPress={() => {
              if (followUp.pickedUpThread !== null) openThread(followUp.pickedUpThread);
            }}
          />
        </SettingsSection>
      ) : null}

      {links.length > 0 ? (
        <SettingsSection title="Links">
          {links.map((link, index) => (
            <View
              key={`${link.kind}:${linkTargetKey(link)}`}
              className={index === 0 ? undefined : "border-t border-border-subtle"}
            >
              <FollowUpLinkRow
                link={link}
                known={props.known}
                onOpenFollowUp={openFollowUp}
                onOpenThread={openThread}
              />
            </View>
          ))}
        </SettingsSection>
      ) : null}

      <SettingsSection title="History">
        {history.data === null ? (
          <Text className="px-4 py-3 text-base text-foreground-muted">
            {history.error ?? "Loading history…"}
          </Text>
        ) : (
          history.data.changes.map((change, index) => (
            <View
              key={`${change.at}:${change.summary}`}
              className={
                index === 0 ? "gap-1 px-4 py-3" : "gap-1 border-t border-border-subtle px-4 py-3"
              }
            >
              <Text textRole="body" className="text-foreground">
                {change.summary}
              </Text>
              <Text textRole="footnote" className="text-foreground-muted">
                {followUpActorLabel(change.actor)} · {formatFollowUpDate(change.at)}
              </Text>
            </View>
          ))
        )}
      </SettingsSection>
    </>
  );
}

function DetailRow(props: {
  readonly label: string;
  readonly value: string;
  readonly first?: boolean;
}) {
  return (
    <View
      className={
        props.first
          ? "flex-row items-start gap-3 px-4 py-3"
          : "flex-row items-start gap-3 border-t border-border-subtle px-4 py-3"
      }
    >
      <Text textRole="body" className="text-foreground-muted">
        {props.label}
      </Text>
      <Text textRole="body" selectable className="min-w-0 flex-1 text-right text-foreground">
        {props.value}
      </Text>
    </View>
  );
}

function linkTargetKey(link: FollowUpLink) {
  return link.target.type === "followUp"
    ? link.target.followUpId
    : `${link.target.environmentId}:${link.target.threadId}`;
}

function FollowUpLinkRow(props: {
  readonly link: FollowUpLink;
  readonly known: ReadonlyArray<FollowUp>;
  readonly onOpenFollowUp: (id: FollowUpId) => void;
  readonly onOpenThread: (ref: ThreadRef) => void;
}) {
  const { target } = props.link;
  const shell = useThreadShell(
    target.type === "thread"
      ? { environmentId: target.environmentId, threadId: target.threadId }
      : null,
  );
  if (target.type === "followUp") {
    return (
      <ListRow
        icon="tray.and.arrow.down"
        label={
          props.known.find((followUp) => followUp.id === target.followUpId)?.title ??
          target.followUpId
        }
        description={props.link.kind}
        onPress={() => props.onOpenFollowUp(target.followUpId)}
      />
    );
  }
  return (
    <ListRow
      icon="text.bubble"
      label={shell?.title ?? "Thread"}
      description={props.link.kind}
      onPress={() => props.onOpenThread(target)}
    />
  );
}

function StartThreadButton(props: {
  readonly originProject: EnvironmentProject | null;
  readonly preferredEnvironmentId: EnvironmentId | null;
  readonly disabled: boolean;
  readonly starting: boolean;
  readonly onStart: (project: EnvironmentProject) => void;
}) {
  const projects = useProjects();
  const connected = useAtomValue(connectedEnvironmentIdsAtom);
  const environments = useWorkspaceEnvironments();
  const { originProject } = props;
  if (originProject !== null) {
    return (
      <Button
        label="Start a thread"
        icon="plus.bubble"
        tone="primary"
        disabled={props.disabled}
        loading={props.starting}
        onPress={() => props.onStart(originProject)}
      />
    );
  }
  // Without the origin thread on this device, the user picks the project.
  const choices = projects
    .filter(
      (project) =>
        project.archivedAt == null &&
        project.workspaceRoot !== "" &&
        connected.includes(project.environmentId),
    )
    .sort(
      (left, right) =>
        Number(right.environmentId === props.preferredEnvironmentId) -
          Number(left.environmentId === props.preferredEnvironmentId) ||
        Number(right.pinnedAt != null) - Number(left.pinnedAt != null) ||
        left.title.localeCompare(right.title),
    );
  const projectAction = (project: EnvironmentProject): MenuAction => ({
    id: `${project.environmentId}\n${project.id}`,
    title: project.title,
  });
  const environmentIds = [...new Set(choices.map((project) => project.environmentId))];
  const actions: MenuAction[] =
    environmentIds.length > 1
      ? environmentIds.map((environmentId) => ({
          id: `environment:${environmentId}`,
          title:
            environments.find((environment) => environment.environmentId === environmentId)
              ?.environmentLabel ?? environmentId,
          subactions: choices
            .filter((project) => project.environmentId === environmentId)
            .map(projectAction),
        }))
      : choices.map(projectAction);
  if (choices.length === 0 || props.disabled || props.starting) {
    return (
      <Button
        label="Start a thread"
        icon="plus.bubble"
        tone="primary"
        disabled
        loading={props.starting}
        onPress={noop}
      />
    );
  }
  return (
    <Menu
      title="Start the thread in"
      actions={actions}
      onPressAction={({ nativeEvent }) => {
        const project = choices.find(
          (candidate) => `${candidate.environmentId}\n${candidate.id}` === nativeEvent.event,
        );
        if (project) props.onStart(project);
      }}
    >
      <Button label="Start a thread" icon="plus.bubble" tone="primary" onPress={noop} />
    </Menu>
  );
}

function noop() {}

function LaterButton(props: {
  readonly followUp: FollowUp;
  readonly disabled: boolean;
  readonly onReschedule: (dueAt: string | null) => void;
}) {
  const [picking, setPicking] = useState<Date | null>(null);
  const nowMs = useNowMinuteMs();
  const presets = resolveSnoozePresets(new Date(nowMs), { presets: FOLLOW_UP_LATER_PRESETS });
  const actions: MenuAction[] = [
    ...presets.map((preset) => ({
      id: `preset:${preset.id}`,
      title: preset.label,
      subtitle: preset.whenLabel,
    })),
    { id: "pick", title: "Pick a date…" },
    ...(props.followUp.dueAt !== null
      ? [{ id: "clear", title: "Clear the date", attributes: { destructive: true } }]
      : []),
  ];
  const pickDefault = () => {
    const date = new Date();
    date.setDate(date.getDate() + 1);
    date.setHours(9, 0, 0, 0);
    return props.followUp.dueAt !== null ? new Date(props.followUp.dueAt) : date;
  };
  const commitPicked = (date: Date) => {
    setPicking(null);
    props.onReschedule(date.toISOString());
  };
  return (
    <>
      {props.disabled ? (
        <Button label="Later" icon="clock" disabled onPress={noop} />
      ) : (
        <Menu
          title="Bring it back"
          actions={actions}
          onPressAction={({ nativeEvent }) => {
            const id = nativeEvent.event;
            if (id === "pick") setPicking(pickDefault());
            else if (id === "clear") props.onReschedule(null);
            else if (id.startsWith("preset:")) {
              const preset = pickSnoozePreset({
                shown: presets,
                id: id.slice("preset:".length),
                now: new Date(),
                presets: FOLLOW_UP_LATER_PRESETS,
              });
              if (preset) props.onReschedule(preset.snoozedUntil);
            }
          }}
        >
          <Button label="Later" icon="clock" onPress={noop} />
        </Menu>
      )}
      {picking !== null ? (
        Platform.OS === "android" ? (
          <DateTimePicker
            value={picking}
            mode="date"
            minimumDate={new Date(nowMs)}
            onDismiss={() => setPicking(null)}
            onValueChange={(_, date) => {
              const next = new Date(date);
              next.setHours(9, 0, 0, 0);
              commitPicked(next);
            }}
          />
        ) : (
          <DatePickerCard onCancel={() => setPicking(null)} onConfirm={() => commitPicked(picking)}>
            <DateTimePicker
              value={picking}
              mode="datetime"
              display="inline"
              minimumDate={new Date(nowMs)}
              onValueChange={(_, date) => setPicking(date)}
            />
          </DatePickerCard>
        )
      ) : null}
    </>
  );
}

function DatePickerCard(props: {
  readonly children: ReactNode;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  return (
    <View className="w-full gap-3 rounded-[24px] border-continuous bg-grouped-card p-3">
      {props.children}
      <View className="flex-row justify-end gap-2">
        <Button label="Cancel" tone="text" onPress={props.onCancel} />
        <Button label="Set date" tone="primary" onPress={props.onConfirm} />
      </View>
    </View>
  );
}
