import { CommandId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  CommandOutboxDeliveryError,
  createCommandOutboxController,
  type CommandOutboxCommand,
  type CommandOutboxEntry,
  type CommandOutboxStore,
} from "./commandOutbox.ts";

interface TestCommand extends CommandOutboxCommand {
  readonly text: string;
  readonly uploadedAttachmentId?: string;
}

function command(text: string, threadId = "thread-a", commandId = `command-${text}`): TestCommand {
  return {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make(threadId),
    commandId: CommandId.make(commandId),
    text,
  };
}

/** Atomic per-entry updates, like one IndexedDB transaction. */
function memoryStore() {
  let nextId = 1;
  const rows = new Map<number, CommandOutboxEntry<TestCommand>>();
  const store: CommandOutboxStore<TestCommand> = {
    list: async () => [...rows.values()],
    add: async (entry) => {
      if ([...rows.values()].some((row) => row.command.commandId === entry.command.commandId)) {
        throw new Error(`Command ${entry.command.commandId} is already in the outbox.`);
      }
      const stored = { ...entry, id: nextId++ };
      rows.set(stored.id, stored);
      return stored;
    },
    update: async (id, change) => {
      const current = rows.get(id);
      if (current === undefined) return undefined;
      const next = change(current);
      if (next === undefined) return undefined;
      if (next === null) {
        rows.delete(id);
        return null;
      }
      rows.set(id, next);
      return next;
    },
  };
  return { store, rows };
}

function manualClock() {
  let time = 1_000_000;
  const timers = new Set<{ readonly at: number; readonly callback: () => void }>();
  return {
    now: () => time,
    setTimer: (callback: () => void, delayMs: number) => {
      const timer = { at: time + delayMs, callback };
      timers.add(timer);
      return () => timers.delete(timer);
    },
    nextTimerAt: () => Math.min(...[...timers].map((timer) => timer.at)),
    advance: (ms: number) => {
      time += ms;
    },
  };
}

type Delivery = (
  entry: CommandOutboxEntry<TestCommand>,
  record: (command: TestCommand) => Promise<void>,
) => Promise<void> | void;

/** Accepts each command id once and replays its receipt afterwards, like the server. */
function environment() {
  const receipts = new Set<string>();
  const accepted: string[] = [];
  const attempts: string[] = [];
  const scripted: Delivery[] = [];
  let reachable = true;
  const accept = (entry: CommandOutboxEntry<TestCommand>) => {
    attempts.push(entry.command.commandId);
    if (receipts.has(entry.command.commandId)) return;
    receipts.add(entry.command.commandId);
    accepted.push(entry.command.text);
  };
  return {
    accepted,
    attempts,
    accept,
    setReachable: (next: boolean) => {
      reachable = next;
    },
    canDeliver: () => reachable,
    /** The next delivery runs `delivery` instead of being accepted. */
    script: (delivery: Delivery) => {
      scripted.push(delivery);
    },
    deliver: async (
      entry: CommandOutboxEntry<TestCommand>,
      record: (command: TestCommand) => Promise<void>,
    ) => {
      const delivery = scripted.shift();
      if (delivery) return delivery(entry, record);
      accept(entry);
    },
  };
}

function setup(storage = memoryStore(), server = environment()) {
  const clock = manualClock();
  const rejected: string[] = [];
  const controller = createCommandOutboxController<TestCommand>({
    store: storage.store,
    canDeliver: server.canDeliver,
    deliver: server.deliver,
    onRejected: (entry) => rejected.push(entry.command.text),
    onError: (error) => {
      throw error;
    },
    now: clock.now,
    setTimer: clock.setTimer,
  });
  return { controller, storage, clock, server, rejected };
}

const lostAcknowledgement = (server: ReturnType<typeof environment>) =>
  server.script((entry) => {
    server.accept(entry);
    throw { _tag: "RpcClientError", message: "SocketCloseError: connection closed" };
  });

const states = (controller: { entries: () => ReadonlyArray<CommandOutboxEntry<TestCommand>> }) =>
  controller.entries().map((entry) => [entry.command.text, entry.state._tag]);

describe("command outbox", () => {
  it("keeps a message sent while offline and delivers it after reconnecting", async () => {
    const { controller, server } = setup();
    server.setReachable(false);

    await controller.enqueue(command("hello"));
    await controller.wake();
    expect(states(controller)).toEqual([["hello", "Pending"]]);
    expect(server.accepted).toEqual([]);

    server.setReachable(true);
    await controller.wake();
    expect(server.accepted).toEqual(["hello"]);
    expect(controller.entries()).toEqual([]);
  });

  it("retries a lost acknowledgement with the same command id and delivers once", async () => {
    const { controller, server, clock } = setup();
    lostAcknowledgement(server);

    await controller.enqueue(command("hello"));
    await controller.wake();
    const [entry] = controller.entries();
    expect(entry?.state).toMatchObject({
      _tag: "Retrying",
      failure: { classification: "ambiguous" },
    });
    expect(await controller.discard(entry!.id)).toBeNull();
    expect(clock.nextTimerAt()).toBe(clock.now() + 1_000);

    clock.advance(1_000);
    await controller.wake();
    expect(server.attempts).toEqual(["command-hello", "command-hello"]);
    expect(server.accepted).toEqual(["hello"]);
    expect(controller.entries()).toEqual([]);
  });

  it("starts an acknowledgement handed over from a direct send as an ambiguous retry", async () => {
    const { controller, server } = setup();
    server.accept({ id: 0, enqueuedAt: 0, command: command("hello"), state: { _tag: "Pending" } });
    server.setReachable(false);

    const entry = await controller.enqueue(command("hello"), { acknowledgementLost: true });
    expect(await controller.discard(entry.id)).toBeNull();

    server.setReachable(true);
    await controller.wake();
    expect(server.accepted).toEqual(["hello"]);
    expect(controller.entries()).toEqual([]);
  });

  it("delivers each thread in order while another thread proceeds", async () => {
    const { controller, server, clock } = setup();
    server.script(() => {
      throw new CommandOutboxDeliveryError({ classification: "transient", message: "Offline" });
    });

    await controller.enqueue(command("a1", "thread-a"));
    await controller.enqueue(command("a2", "thread-a"));
    await controller.enqueue(command("b1", "thread-b"));
    await controller.wake();
    expect(server.accepted).toEqual(["b1"]);
    expect(states(controller)).toEqual([
      ["a1", "Retrying"],
      ["a2", "Pending"],
    ]);

    clock.advance(1_000);
    await controller.wake();
    expect(server.accepted).toEqual(["b1", "a1", "a2"]);
  });

  it("holds a rejected command at its thread's head until the user acts", async () => {
    const { controller, server, rejected } = setup();
    server.script(() => {
      throw { _tag: "OrchestrationV2DispatchCommandError", message: "Thread was deleted." };
    });

    await controller.enqueue(command("a1"));
    await controller.enqueue(command("a2"));
    await controller.wake();
    expect(rejected).toEqual(["a1"]);
    expect(states(controller)).toEqual([
      ["a1", "Rejected"],
      ["a2", "Pending"],
    ]);
    expect(controller.entries()[0]?.state).toMatchObject({
      failure: { classification: "permanent", message: "Thread was deleted." },
    });

    const [head] = controller.entries();
    await controller.retry(head!.id, CommandId.make("command-a1-again"));
    await controller.wake();
    expect(server.attempts).toEqual(["command-a1-again", "command-a2"]);
    expect(server.accepted).toEqual(["a1", "a2"]);
  });

  it("lets a discarded rejection release the rest of its thread", async () => {
    const { controller, server } = setup();
    server.script(() => {
      throw { _tag: "OrchestrationV2DispatchCommandError", message: "Rejected" };
    });

    await controller.enqueue(command("a1"));
    await controller.enqueue(command("a2"));
    await controller.wake();
    const removed = await controller.discard(controller.entries()[0]!.id);
    await controller.wake();

    expect(removed?.command.text).toBe("a1");
    expect(server.accepted).toEqual(["a2"]);
  });

  it("redelivers a delivery interrupted by a reload under the same command id", async () => {
    const first = setup();
    let finishHungDelivery: () => void = () => {};
    const deliveryStarted = new Promise<void>((started) => {
      first.server.script((entry) => {
        first.server.accept(entry);
        started();
        return new Promise<void>((finish) => {
          finishHungDelivery = finish;
        });
      });
    });
    await first.controller.enqueue(command("hello"));
    const hungDrain = first.controller.wake();
    await deliveryStarted;
    expect([...first.storage.rows.values()].map((entry) => entry.state._tag)).toEqual([
      "Delivering",
    ]);
    first.controller.dispose();

    const reloaded = setup(first.storage, first.server);
    await reloaded.controller.wake();
    expect(first.server.attempts).toEqual(["command-hello", "command-hello"]);
    expect(first.server.accepted).toEqual(["hello"]);
    expect(reloaded.controller.entries()).toEqual([]);

    finishHungDelivery();
    await hungDrain;
  });

  it("refuses a second command with the same id", async () => {
    const { controller, server } = setup();
    server.setReachable(false);

    await controller.enqueue(command("hello"));
    await expect(
      controller.enqueue(command("hello again", "thread-a", "command-hello")),
    ).rejects.toThrow("already in the outbox");
    expect(states(controller)).toEqual([["hello", "Pending"]]);
  });

  it("keeps recorded preparation for the next attempt", async () => {
    const { controller, server, clock } = setup();
    const seenUploads: Array<string | undefined> = [];
    server.script(async (entry, record) => {
      seenUploads.push(entry.command.uploadedAttachmentId);
      await record({ ...entry.command, uploadedAttachmentId: "upload-1" });
      throw new CommandOutboxDeliveryError({ classification: "transient", message: "Offline" });
    });
    server.script((entry) => {
      seenUploads.push(entry.command.uploadedAttachmentId);
      server.accept(entry);
    });

    await controller.enqueue(command("photo"));
    await controller.wake();
    clock.advance(1_000);
    await controller.wake();

    expect(seenUploads).toEqual([undefined, "upload-1"]);
    expect(server.accepted).toEqual(["photo"]);
  });

  it("drops entries the environment already holds", async () => {
    const { controller, server } = setup();
    server.script(() => {
      throw { _tag: "OrchestrationV2DispatchCommandError", message: "Attachment not found" };
    });

    await controller.enqueue(command("a1"));
    await controller.wake();
    expect(states(controller)).toEqual([["a1", "Rejected"]]);

    await controller.settle((pending) => pending.text === "a1");
    expect(controller.entries()).toEqual([]);
  });
});
