import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { placementWaitOf } from "@t3tools/client-runtime/state/placement-wait";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { msg, useGT } from "gt-react-native";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { m } from "../../i18n/messages";
import { serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

/** A placed thread waiting for room on its machine, with start anyway and cancel. */
export function PlacementWaitCard({
  thread,
  environmentId,
  canOperate,
}: {
  thread: EnvironmentThreadShell;
  environmentId: EnvironmentId;
  /** A read-only connection sees the wait without its actions. */
  canOperate: boolean;
}) {
  const startNow = useAtomCommand(serverEnvironment.placementStartNow);
  const interrupt = useAtomCommand(threadEnvironment.interruptTurn);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gt = useGT();
  const wait = placementWaitOf(thread);
  if (wait === null) return null;
  const { placement, cancelRunId } = wait;
  async function run(action: "start" | "cancel") {
    setPending(true);
    setError(null);
    const result =
      action === "start"
        ? await startNow({ environmentId, input: { threadId: thread.id } })
        : await interrupt({
            environmentId,
            input: {
              threadId: thread.id,
              runId: cancelRunId,
            },
          });
    setPending(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setError(
        failure instanceof Error ? failure.message : m(msg("That did not work. Try again.")),
      );
    }
  }
  return (
    <View className="mx-3 mb-2 gap-1 rounded-xl border border-border bg-screen p-3">
      <Text className="text-sm font-t3-medium text-foreground">
        {gt("Waiting for room on {machine}", { machine: placement.label })}
      </Text>
      <Text className="text-sm text-foreground-muted">{placement.reason}</Text>
      {/* The margins cancel the 44pt touch height so the actions sit 8pt under the text. */}
      {canOperate ? (
        <View className="-mb-3 -mt-2 flex-row flex-wrap gap-x-4">
          <WaitAction
            label={gt("Start anyway")}
            disabled={pending}
            onPress={() => void run("start")}
          />
          <WaitAction
            label={gt("Cancel", { $context: "verb, stops a thread waiting for room" })}
            disabled={pending}
            onPress={() => void run("cancel")}
          />
        </View>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-destructive">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

function WaitAction(props: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      hitSlop={{ left: 8, right: 8 }}
      onPress={props.onPress}
      className="min-h-11 justify-center active:opacity-70"
    >
      <Text
        className={
          props.disabled
            ? "text-sm font-t3-medium text-foreground-muted"
            : "text-sm font-t3-medium text-primary"
        }
      >
        {props.label}
      </Text>
    </Pressable>
  );
}
