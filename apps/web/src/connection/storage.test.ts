import { ConnectionTransientError } from "@t3tools/client-runtime/connection";
import { ConnectionCatalogDocument } from "@t3tools/client-runtime/platform";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, vi } from "vite-plus/test";

import { makeCatalogBackend, makeCatalogStore, readDatabaseValue } from "./storage";

const emptyCatalog = {
  schemaVersion: 1,
  targets: [],
  profiles: [],
  credentials: [],
  remoteDpopTokens: [],
} as const;
const decodeCatalog = Schema.decodeUnknownSync(Schema.fromJsonString(ConnectionCatalogDocument));

function pendingDatabaseRead() {
  const request = Object.assign(new EventTarget(), { result: "cached value", error: null });
  const abort = vi.fn();
  const database = {
    transaction: () => ({
      objectStore: () => ({ get: () => request }),
      abort,
    }),
  } as unknown as IDBDatabase;
  return { database, request, abort };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("readDatabaseValue", () => {
  for (const storeName of ["shell", "server-config", "thread", "vcs-refs"]) {
    it.effect(`releases a stalled ${storeName} read so the caller can load from the server`, () =>
      Effect.gen(function* () {
        const { database, abort } = pendingDatabaseRead();
        const read = yield* readDatabaseValue(database, storeName, "key").pipe(
          Effect.asVoid,
          Effect.flip,
          Effect.forkScoped({ startImmediately: true }),
        );

        yield* TestClock.adjust("2 seconds");
        const error = yield* Fiber.join(read);

        expect(error).toBeInstanceOf(ConnectionTransientError);
        expect(error.message).toContain("read cache");
        expect(abort).toHaveBeenCalledOnce();
      }).pipe(Effect.scoped),
    );
  }

  it.effect("returns a successful cache read without aborting its transaction", () =>
    Effect.gen(function* () {
      const { database, request, abort } = pendingDatabaseRead();
      const read = yield* readDatabaseValue(database, "shell", "key").pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      request.dispatchEvent(new Event("success"));

      expect(yield* Fiber.join(read)).toBe("cached value");
      expect(abort).not.toHaveBeenCalled();
    }).pipe(Effect.scoped),
  );

  it.effect("does not treat a slow credential catalog as a cache miss", () =>
    Effect.gen(function* () {
      const { database, request, abort } = pendingDatabaseRead();
      const read = yield* readDatabaseValue(database, "catalog", "key").pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* TestClock.adjust("3 seconds");
      expect(abort).not.toHaveBeenCalled();
      request.dispatchEvent(new Event("success"));
      expect(yield* Fiber.join(read)).toBe("cached value");
    }).pipe(Effect.scoped),
  );
});

describe("makeCatalogStore", () => {
  it.effect("quarantines malformed catalogs and starts from an empty document", () =>
    Effect.gen(function* () {
      const writes: string[] = [];
      const quarantined: string[] = [];
      const store = yield* makeCatalogStore({
        read: Effect.succeed("{not-json"),
        write: (raw) => Effect.sync(() => writes.push(raw)),
        quarantine: (raw) => Effect.sync(() => quarantined.push(raw)),
      });

      expect(yield* store.read).toEqual(emptyCatalog);
      expect(quarantined).toEqual(["{not-json"]);
      expect(writes).toHaveLength(1);
      expect(decodeCatalog(writes[0]!)).toEqual(emptyCatalog);
    }),
  );

  it.effect("does not hide catalog read failures", () =>
    Effect.gen(function* () {
      const failure = new ConnectionTransientError({
        reason: "remote-unavailable",
        detail: "permission denied",
      });
      const store = yield* makeCatalogStore({
        read: Effect.fail(failure),
        write: () => Effect.void,
      });

      expect(yield* Effect.flip(store.read)).toBe(failure);
    }),
  );
});

describe("makeCatalogBackend", () => {
  it.effect("fails writes when desktop secure storage declines the catalog", () =>
    Effect.gen(function* () {
      const setConnectionCatalog = vi.fn().mockResolvedValue(false);
      vi.stubGlobal("window", {
        desktopBridge: {
          getConnectionCatalog: vi.fn().mockResolvedValue(null),
          setConnectionCatalog,
        },
      });
      const backend = makeCatalogBackend({} as IDBDatabase);

      const error = yield* backend.write("{}").pipe(Effect.flip);

      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error.message).toContain("Desktop secure storage is unavailable");
      expect(setConnectionCatalog).toHaveBeenCalledWith("{}");
    }),
  );
});
