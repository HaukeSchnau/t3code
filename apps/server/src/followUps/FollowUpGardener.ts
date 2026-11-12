import {
  CommandId,
  type EnvironmentId,
  FollowUpError,
  type FollowUpGardenerRun,
  MessageId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as FollowUps from "./FollowUps.ts";

/** The nightly pass that keeps a home's follow-ups tidy, run as an agent thread. */
export class FollowUpGardener extends Context.Service<
  FollowUpGardener,
  {
    readonly runNow: Effect.Effect<FollowUpGardenerRun, FollowUpError>;
  }
>()("t3/followUps/FollowUpGardener") {}

const isFollowUpError = Schema.is(FollowUpError);
const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)$/;
const RETRY_AFTER_MS = 60 * 60 * 1_000;

/** The latest scheduled moment at or before `now`, in the server's local zone. */
const latestSlot = (now: DateTime.Zoned, timeOfDay: string): DateTime.Zoned | null => {
  const match = TIME_OF_DAY.exec(timeOfDay);
  if (match === null) return null;
  const today = DateTime.setParts(now, {
    hour: Number(match[1]),
    minute: Number(match[2]),
    second: 0,
    millisecond: 0,
  });
  return DateTime.isGreaterThan(today, now) ? DateTime.subtract(today, { days: 1 }) : today;
};

const gardenerPrompt = (input: {
  readonly since: string | null;
  readonly members: ReadonlyArray<EnvironmentId>;
}) => {
  const machines =
    input.members.length === 0
      ? "this machine"
      : `this machine and the linked machines that keep their follow-ups here (environmentId ${input.members.join(", ")})`;
  return [
    "Tend the follow-ups. This is the nightly pass, and nobody is watching it run.",
    "",
    "Follow-ups are the open work that agents and Hauke wrote down to come back to; `follow_ups` reads them and `follow_up_save` changes them. Every change is logged and can be undone, so act on your own judgement:",
    "",
    "- Merge duplicates into the clearest one.",
    "- Close what the repository, a pull request or a thread shows is done, with the result.",
    "- Check each plain-language condition. When one has come true, set its date to now so it comes back to Hauke's inbox.",
    "- Keep the types consistent: fold types and fields that mean the same thing into one.",
    `- Read the threads settled ${
      input.since === null ? "in the last day" : `since ${input.since}`
    } on ${machines}, and write down follow-ups that nobody wrote. Keep the bar high: only work someone would regret losing, never a summary of what a thread finished. Origin is the thread you read it in (\`fromThread\`).`,
    "",
    "End with one short report: each change on its own line with the follow-up's id, or a line saying there was nothing to do.",
  ].join("\n");
};

const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const followUps = yield* FollowUps.FollowUps;
  const launches = yield* ThreadLaunchService.ThreadLaunchService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const projects = yield* ProjectService.ProjectService;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const scheduler = yield* Scheduler.Scheduler;
  const random = yield* SecureRandom.SecureRandom;
  const environmentId = yield* environment.getEnvironmentId;
  const running = yield* Semaphore.make(1);
  const isHome = config.followUpHome === undefined || config.followUpHome === environmentId;

  const launch = Effect.fn("FollowUpGardener.launch")(
    function* () {
      const snapshot = yield* followUps.snapshot({});
      // One pass at a time: a pass still working answers for the next request.
      const last = snapshot.lastGardenerRun;
      if (last !== null) {
        const shell = yield* threads.getThreadShell(last.thread.threadId);
        if ((shell?.activityRunStatus ?? null) !== null) return last;
      }
      const now = yield* DateTime.now;
      const { projectId } = yield* folders.ensureScratchProject;
      const settings = yield* settingsService.getSettings;
      const project = yield* projects.getById(projectId).pipe(Effect.map(Option.getOrUndefined));
      const projectSettings = resolveProjectSettings(settings, projectId, project).settings;
      const modelSelection = resolveNewThreadModelSelection({
        defaultSelection: projectSettings.defaultModelSelection,
        fallbackSelection: projectSettings.fallbackModelSelection,
        providers: yield* providers.getProviders,
        settings: projectSettings,
        projectId,
        now: DateTime.toEpochMillis(now),
      }).selection;
      if (modelSelection === null) {
        return yield* new FollowUpError({
          message: "The gardener needs a default model; set one in Settings.",
        });
      }
      const id = yield* random.uuidV4();
      const launched = yield* launches.launch({
        commandId: CommandId.make(`follow-up-gardener:${id}`),
        projectId,
        title: `Follow-up gardener ${DateTime.formatIsoDate(now)}`,
        modelSelection,
        runtimeMode: projectSettings.defaultRuntimeMode,
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        initialMessage: {
          messageId: MessageId.make(`follow-up-gardener:${id}`),
          text: gardenerPrompt({
            since: snapshot.lastGardenerRun?.startedAt ?? null,
            members: config.followUpMembers ?? [],
          }),
          attachments: [],
        },
        createdBy: "system",
        creationSource: "server",
      });
      const run: FollowUpGardenerRun = {
        thread: { environmentId, threadId: launched.threadId },
        startedAt: DateTime.formatIso(now),
      };
      yield* followUps.recordGardenerRun(run);
      return run;
    },
    (effect) => running.withPermits(1)(effect),
    Effect.mapError((cause) =>
      isFollowUpError(cause)
        ? cause
        : new FollowUpError({ message: "Could not start the gardener", cause }),
    ),
  );

  const nextCheck = yield* Ref.make(0);
  const timeOfDay = config.followUpGardenerAt;
  if (timeOfDay !== undefined && isHome) {
    if (!TIME_OF_DAY.test(timeOfDay)) {
      yield* Effect.logWarning(
        "T3CODE_FOLLOW_UP_GARDENER_AT is not HH:MM; the nightly pass is off",
        {
          timeOfDay,
        },
      );
    } else {
      const tick = Effect.gen(function* () {
        const now = yield* DateTime.nowInCurrentZone.pipe(DateTime.withCurrentZoneLocal);
        const nowMs = DateTime.toEpochMillis(now);
        if (nowMs < (yield* Ref.get(nextCheck))) return;
        const slot = latestSlot(now, timeOfDay);
        if (slot === null) return;
        const last = (yield* followUps.snapshot({})).lastGardenerRun;
        const ranSinceSlot =
          last !== null &&
          Option.match(DateTime.make(last.startedAt), {
            onNone: () => false,
            onSome: (startedAt) =>
              DateTime.toEpochMillis(startedAt) >= DateTime.toEpochMillis(slot),
          });
        if (!ranSinceSlot) {
          yield* Ref.set(nextCheck, nowMs + RETRY_AFTER_MS);
          const started = yield* launch().pipe(
            Effect.as(true),
            Effect.catch((error) =>
              Effect.logWarning("The nightly follow-up gardener did not start", {
                message: error.message,
                cause: error.cause,
              }).pipe(Effect.as(false)),
            ),
          );
          if (!started) return;
        }
        // Nothing is due before the next slot, a day after this one.
        yield* Ref.set(nextCheck, DateTime.toEpochMillis(DateTime.add(slot, { days: 1 })));
      });
      yield* scheduler.register("follow-up-gardener", tick);
    }
  }

  return FollowUpGardener.of({
    runNow: isHome
      ? launch()
      : Effect.fail(
          new FollowUpError({
            message: "This machine keeps its follow-ups on another one; run the gardener there.",
          }),
        ),
  });
});

export const layer = Layer.effect(FollowUpGardener, make);
