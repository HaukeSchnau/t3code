import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type {
  RelayAgentActivityState,
  RelayDeviceRegistrationRequest,
} from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ApnsProvider from "./ApnsProvider.ts";
import {
  make as makeLocalAgentAwareness,
  makeLocalAgentActivityAggregate,
  type NeedsYouPush,
} from "./LocalAgentAwareness.ts";

function makeMemorySecretStore() {
  const values = new Map<string, Uint8Array>();
  return {
    get: ((name) =>
      Effect.sync(() => {
        const value = values.get(name);
        return value === undefined ? Option.none() : Option.some(Uint8Array.from(value));
      })) satisfies ServerSecretStore.ServerSecretStore["Service"]["get"],
    set: ((name, value) =>
      Effect.sync(() => {
        values.set(name, Uint8Array.from(value));
      })) satisfies ServerSecretStore.ServerSecretStore["Service"]["set"],
    create: ((name, value) =>
      Effect.sync(() => {
        values.set(name, Uint8Array.from(value));
      })) satisfies ServerSecretStore.ServerSecretStore["Service"]["create"],
    getOrCreateRandom: ((name, bytes) =>
      Effect.sync(() => {
        const existing = values.get(name);
        if (existing) return existing;
        const generated = new Uint8Array(bytes);
        values.set(name, generated);
        return generated;
      })) satisfies ServerSecretStore.ServerSecretStore["Service"]["getOrCreateRandom"],
    remove: ((name) =>
      Effect.sync(() => {
        values.delete(name);
      })) satisfies ServerSecretStore.ServerSecretStore["Service"]["remove"],
  } satisfies ServerSecretStore.ServerSecretStore["Service"];
}

const runningState = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  projectTitle: "T3 Code",
  threadTitle: "Accountless notifications",
  phase: "running",
  headline: "Working",
  modelTitle: "Codex",
  updatedAt: "2026-08-10T12:00:00.000Z",
  deepLink: "/environment/environment-1/thread/thread-1",
} satisfies RelayAgentActivityState;

const registration = {
  deviceId: "device-1",
  label: "iPhone",
  platform: "ios",
  iosMajorVersion: 27,
  bundleId: "dev.schnau.t3code",
  apsEnvironment: "sandbox",
  pushToken: "device-token",
  preferences: {
    liveActivitiesEnabled: true,
    notificationsEnabled: true,
    notifyOnApproval: true,
    notifyOnInput: true,
    notifyOnCompletion: true,
    notifyOnFailure: true,
  },
} satisfies RelayDeviceRegistrationRequest;

describe("local agent-awareness aggregation", () => {
  it("keeps the single environment's active and recent terminal rows in one card", () => {
    const completed = {
      ...runningState,
      threadId: ThreadId.make("thread-2"),
      threadTitle: "Earlier task",
      phase: "completed",
      headline: "Done",
      updatedAt: "2026-08-10T11:59:00.000Z",
    } satisfies RelayAgentActivityState;

    expect(
      makeLocalAgentActivityAggregate({
        states: [runningState, completed],
        terminalState: null,
        nowMs: Date.parse("2026-08-10T12:01:00.000Z"),
      }),
    ).toMatchObject({
      subtitle: "Agent work in progress",
      activeCount: 1,
      activities: [
        { threadId: "thread-1", status: "Working" },
        { threadId: "thread-2", status: "Done" },
      ],
    });
  });

  it("keeps the needs-you count when no row is left, for the widget", () => {
    const nowMs = Date.parse("2026-08-10T12:00:00.000Z");
    expect(
      makeLocalAgentActivityAggregate({
        states: [],
        terminalState: null,
        nowMs,
        attentionCount: 2,
      }),
    ).toMatchObject({ activeCount: 0, attentionCount: 2, activities: [] });
    expect(
      makeLocalAgentActivityAggregate({
        states: [],
        terminalState: null,
        nowMs,
        attentionCount: 0,
      }),
    ).toBeNull();
  });

  it("expires abandoned running work from the aggregate", () => {
    expect(
      makeLocalAgentActivityAggregate({
        states: [runningState],
        terminalState: null,
        nowMs: Date.parse("2026-08-10T14:00:01.000Z"),
      }),
    ).toBeNull();
  });

  const delivered = { ok: true, status: 200, reason: null, apnsId: "apns-id" } as const;

  const makeAwareness = (apns: ApnsProvider.ApnsProvider["Service"]) =>
    makeLocalAgentAwareness.pipe(
      Effect.provideService(ServerSecretStore.ServerSecretStore, makeMemorySecretStore()),
      Effect.provideService(ApnsProvider.ApnsProvider, apns),
    );

  it.effect(
    "updates the Live Activity from rows without alerting, keeps a push token that changed meanwhile, and sends a refused end again",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-08-10T12:00:30.000Z"));
        const updates = yield* Ref.make<ReadonlyArray<string>>([]);
        const sending = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        // APNs refuses the first end for now.
        let endFails = 1;
        const awareness = yield* makeAwareness({
          configured: true,
          sendLiveActivity: (input) =>
            Deferred.succeed(sending, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(Ref.update(updates, (all) => [...all, input.event])),
              Effect.andThen(
                Effect.sync(() =>
                  input.event === "end" && endFails-- > 0
                    ? { ...delivered, ok: false, status: 503 }
                    : delivered,
                ),
              ),
            ),
          sendBadge: () => Effect.die("Badge delivery was not expected"),
          sendNotification: () => Effect.die("Rows must not alert"),
        });
        yield* awareness.registerDevice(registration);
        yield* awareness.publish({ threadId: runningState.threadId, state: runningState });
        // The phone registers a new push token while its Live Activity's first update is sent.
        const registering = yield* awareness
          .registerLiveActivity({
            deviceId: registration.deviceId,
            activityPushToken: "activity-token",
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(sending);
        yield* awareness.registerDevice({ ...registration, pushToken: "new-token" });
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(registering);
        expect(yield* awareness.alertTargets("input")).toEqual(["new-token"]);
        for (const phase of ["waiting_for_input", "completed"] as const) {
          yield* awareness.publish({
            threadId: runningState.threadId,
            state: { ...runningState, phase, updatedAt: "2026-08-10T12:00:20.000Z" },
          });
        }
        // The next publication sends the end again.
        yield* awareness.publish({ threadId: runningState.threadId, state: null });
        expect(yield* Ref.get(updates)).toEqual(["update", "update", "end", "end"]);
      }),
  );

  it.effect("delivers an alert to a device that wants it, and says what became of it", () =>
    Effect.gen(function* () {
      const sent = yield* Ref.make<ReadonlyArray<Record<string, unknown>>>([]);
      let next: ApnsProvider.ApnsDeliveryResult | "no answer" = delivered;
      // What the provider reports when APNs does not answer by its deadline.
      const noAnswer = new ApnsProvider.ApnsProviderDeliveryError({
        message: "APNs did not answer.",
        tokenSuffix: "e-token",
        cause: "deadline",
      });
      const awareness = yield* makeAwareness({
        configured: true,
        sendLiveActivity: () => Effect.die("Live Activity delivery was not expected"),
        sendBadge: () => Effect.succeed(delivered),
        sendNotification: ({ target: _target, ...input }) =>
          Ref.update(sent, (all) => [...all, input]).pipe(
            Effect.andThen(
              Effect.suspend(() =>
                next === "no answer" ? Effect.fail(noAnswer) : Effect.succeed(next),
              ),
            ),
          ),
      });
      yield* awareness.registerDevice(registration);
      yield* awareness.setNeedsYouCount(2);
      const push: NeedsYouPush = {
        title: "Accountless notifications",
        body: "Pick blue or green?",
        environmentId: runningState.environmentId,
        threadId: runningState.threadId,
        deepLink: runningState.deepLink,
        kind: "input",
        collapseKey: "run:1",
      };
      const deliver = (silent = false, input: Partial<NeedsYouPush> = {}) =>
        awareness.deliverAlert({
          token: "device-token",
          prepare: Effect.succeed({ push: { ...push, ...input }, silent }),
        });
      expect(yield* awareness.alertTargets("input")).toEqual(["device-token"]);
      expect(yield* deliver()).toBe("accepted");
      expect(yield* deliver(true)).toBe("accepted");
      expect(yield* deliver(false, { kind: "digest", title: "2 threads need you" })).toBe(
        "accepted",
      );
      expect(
        (yield* Ref.get(sent)).map((input) => [
          input.title,
          input.collapseId,
          input.badge,
          input.category,
          input.interruptionLevel,
          input.silent,
        ]),
      ).toEqual([
        // A question breaks through Focus.
        [
          "Accountless notifications",
          ApnsProvider.apnsCollapseId("run:1"),
          2,
          "AGENT_INPUT",
          "time-sensitive",
          false,
        ],
        // An ask replacing its run's "Done" is quiet.
        [
          "Accountless notifications",
          ApnsProvider.apnsCollapseId("run:1"),
          2,
          "AGENT_INPUT",
          undefined,
          true,
        ],
        [
          "2 threads need you",
          ApnsProvider.apnsCollapseId("run:1"),
          2,
          undefined,
          undefined,
          false,
        ],
      ]);

      // Server trouble passes; a refusal does not; no answer by the deadline fails.
      next = { ...delivered, ok: false, status: 503 };
      expect(yield* deliver()).toBe("failed");
      next = { ...delivered, ok: false, status: 400, reason: "PayloadTooLarge" };
      expect(yield* deliver()).toBe("rejected");
      next = "no answer";
      expect(yield* deliver()).toBe("failed");

      // A device that turned this kind off, or another token, no longer gets it.
      yield* awareness.registerDevice({
        ...registration,
        preferences: { ...registration.preferences, notifyOnInput: false },
      });
      expect(yield* awareness.alertTargets("input")).toEqual([]);
      expect(yield* deliver()).toBe("gone");
      expect(
        yield* awareness.deliverAlert({
          token: "other-token",
          prepare: Effect.succeed({ push, silent: false }),
        }),
      ).toBe("gone");
    }),
  );

  it.effect("decides an alert only once it holds the lock a badge request kept", () =>
    Effect.gen(function* () {
      const badgeSending = yield* Deferred.make<void>();
      const releaseBadge = yield* Deferred.make<void>();
      const sent = yield* Ref.make<ReadonlyArray<string>>([]);
      const awareness = yield* makeAwareness({
        configured: true,
        sendLiveActivity: () => Effect.succeed(delivered),
        sendBadge: () =>
          Deferred.succeed(badgeSending, undefined).pipe(
            Effect.andThen(Deferred.await(releaseBadge)),
            Effect.as(delivered),
          ),
        sendNotification: (input) =>
          Ref.update(sent, (all) => [...all, input.body]).pipe(Effect.as(delivered)),
      });
      yield* awareness.registerDevice(registration);
      yield* awareness.setNeedsYouCount(1);
      yield* TestClock.adjust("3 seconds");
      yield* Deferred.await(badgeSending);
      let open = true;
      const alert = yield* awareness
        .deliverAlert({
          token: "device-token",
          prepare: Effect.sync(() =>
            open
              ? {
                  push: {
                    title: "Accountless notifications",
                    body: "Pick blue or green?",
                    environmentId: runningState.environmentId,
                    threadId: runningState.threadId,
                    deepLink: runningState.deepLink,
                    kind: "input" as const,
                    collapseKey: "ask:1",
                  },
                  silent: false,
                }
              : null,
          ),
        })
        .pipe(Effect.forkChild({ startImmediately: true }));
      // The user answers while the badge request holds the lock.
      open = false;
      yield* Deferred.succeed(releaseBadge, undefined);
      expect(yield* Fiber.join(alert)).toBe("cancelled");
      expect(yield* Ref.get(sent)).toEqual([]);
    }),
  );

  it.effect(
    "coalesces count changes into one badge push and retries a device whose last one failed",
    () =>
      Effect.gen(function* () {
        const badges = yield* Ref.make<ReadonlyArray<string>>([]);
        let failNext = false;
        const awareness = yield* makeAwareness({
          configured: true,
          sendLiveActivity: () => Effect.succeed(delivered),
          sendNotification: () => Effect.succeed(delivered),
          sendBadge: (input) =>
            Effect.suspend(() => {
              const ok = !failNext;
              failNext = false;
              return Ref.update(badges, (all) => [
                ...all,
                `${input.target.token}:${input.badge}${ok ? "" : " failed"}`,
              ]).pipe(Effect.as(ok ? delivered : { ...delivered, ok: false, status: 500 }));
            }),
        });
        yield* awareness.registerDevice(registration);
        yield* awareness.setNeedsYouCount(1);
        yield* TestClock.adjust("2 seconds");
        yield* awareness.setNeedsYouCount(2);
        yield* awareness.setNeedsYouCount(3);
        expect(yield* Ref.get(badges)).toEqual([]);
        yield* TestClock.adjust("1 second");
        expect(yield* Ref.get(badges)).toEqual(["device-token:3"]);

        // The same count again sends nothing.
        yield* awareness.setNeedsYouCount(3);
        yield* TestClock.adjust("3 seconds");
        expect(yield* Ref.get(badges)).toEqual(["device-token:3"]);

        failNext = true;
        yield* awareness.setNeedsYouCount(4);
        yield* TestClock.adjust("3 seconds");
        // The next reconcile, with no change in the count, tries that device again.
        yield* awareness.setNeedsYouCount(4);
        yield* TestClock.adjust("3 seconds");
        expect((yield* Ref.get(badges)).slice(1)).toEqual([
          "device-token:4 failed",
          "device-token:4",
        ]);

        // A new token has no count yet.
        yield* awareness.registerDevice({ ...registration, pushToken: "new-token" });
        yield* TestClock.adjust("3 seconds");
        expect((yield* Ref.get(badges)).at(-1)).toBe("new-token:4");
      }),
  );
});
