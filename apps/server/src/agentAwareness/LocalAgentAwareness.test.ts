import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type {
  RelayAgentActivityState,
  RelayDeviceRegistrationRequest,
} from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ApnsProvider from "./ApnsProvider.ts";
import {
  alertForLocalAgentActivityTransition,
  make as makeLocalAgentAwareness,
  makeLocalAgentActivityAggregate,
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

  it("alerts once when a thread enters an enabled attention phase", () => {
    const previous = makeLocalAgentActivityAggregate({
      states: [runningState],
      terminalState: null,
      nowMs: Date.parse("2026-08-10T12:00:10.000Z"),
    });
    const waiting = {
      ...runningState,
      phase: "waiting_for_approval",
      headline: "Approval",
      updatedAt: "2026-08-10T12:00:20.000Z",
    } satisfies RelayAgentActivityState;
    const next = makeLocalAgentActivityAggregate({
      states: [waiting],
      terminalState: null,
      nowMs: Date.parse("2026-08-10T12:00:20.000Z"),
    });

    expect(
      alertForLocalAgentActivityTransition({
        previous,
        next,
        registration,
        nowMs: Date.parse("2026-08-10T12:00:20.000Z"),
      }),
    ).toEqual({ title: "Accountless notifications", body: "Approval: T3 Code" });
    expect(
      alertForLocalAgentActivityTransition({
        previous: next,
        next,
        registration,
        nowMs: Date.parse("2026-08-10T12:00:21.000Z"),
      }),
    ).toBeNull();
  });

  it("does not replay stale completion alerts", () => {
    const completed = {
      ...runningState,
      phase: "completed",
      headline: "Done",
      updatedAt: "2026-08-10T11:55:00.000Z",
    } satisfies RelayAgentActivityState;
    const next = makeLocalAgentActivityAggregate({
      states: [completed],
      terminalState: completed,
      nowMs: Date.parse("2026-08-10T12:00:00.000Z"),
    });

    expect(
      alertForLocalAgentActivityTransition({
        previous: null,
        next,
        registration,
        nowMs: Date.parse("2026-08-10T12:00:00.000Z"),
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

  it("finds an attention transition below a newer non-alerting row", () => {
    const secondRunning = {
      ...runningState,
      threadId: ThreadId.make("thread-2"),
      threadTitle: "Needs approval",
      updatedAt: "2026-08-10T12:00:10.000Z",
    } satisfies RelayAgentActivityState;
    const previous = makeLocalAgentActivityAggregate({
      states: [runningState, secondRunning],
      terminalState: null,
      nowMs: Date.parse("2026-08-10T12:00:10.000Z"),
    });
    const newerFirstRow = { ...runningState, updatedAt: "2026-08-10T12:00:30.000Z" };
    const waitingSecondRow = {
      ...secondRunning,
      phase: "waiting_for_approval",
      updatedAt: "2026-08-10T12:00:20.000Z",
    } satisfies RelayAgentActivityState;
    const next = makeLocalAgentActivityAggregate({
      states: [newerFirstRow, waitingSecondRow],
      terminalState: null,
      nowMs: Date.parse("2026-08-10T12:00:30.000Z"),
    });

    expect(
      alertForLocalAgentActivityTransition({
        previous,
        next,
        registration,
        nowMs: Date.parse("2026-08-10T12:00:30.000Z"),
      }),
    ).toEqual({ title: "Needs approval", body: "Approval: T3 Code" });
  });

  it.effect("delivers repeated completion notifications for the same thread", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-08-10T12:01:00.000Z"));
      const deliveryCount = yield* Ref.make(0);
      const apns = {
        configured: true,
        sendLiveActivity: () => Effect.die("Live Activity delivery was not expected"),
        sendNotification: () =>
          Ref.update(deliveryCount, (count) => count + 1).pipe(
            Effect.as({ ok: true, status: 200, reason: null, apnsId: "apns-id" }),
          ),
      } satisfies ApnsProvider.ApnsProvider["Service"];
      const awareness = yield* makeLocalAgentAwareness.pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, makeMemorySecretStore()),
        Effect.provideService(ApnsProvider.ApnsProvider, apns),
      );
      yield* awareness.registerDevice({
        ...registration,
        preferences: { ...registration.preferences, liveActivitiesEnabled: false },
      });

      const publish = (phase: "running" | "completed", updatedAt: string) =>
        awareness.publish({
          threadId: runningState.threadId,
          state: {
            ...runningState,
            phase,
            headline: phase === "completed" ? "Done" : "Working",
            updatedAt,
          },
        });

      yield* publish("running", "2026-08-10T12:00:00.000Z");
      yield* publish("completed", "2026-08-10T12:00:10.000Z");
      yield* publish("running", "2026-08-10T12:00:20.000Z");
      yield* publish("completed", "2026-08-10T12:00:30.000Z");

      expect(yield* Ref.get(deliveryCount)).toBe(2);
    }),
  );
});
