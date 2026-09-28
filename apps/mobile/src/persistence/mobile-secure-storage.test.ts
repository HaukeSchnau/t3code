import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

// The keychain, keyed by service and item. Accessibility is recorded per write.
const keychain = vi.hoisted(() => ({
  items: new Map<string, string>(),
  accessibility: new Map<string, unknown>(),
}));
const slot = (key: string, options?: { readonly keychainService?: string }) =>
  `${options?.keychainService ?? "app"}/${key}`;

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
}));

vi.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK: "after-first-unlock",
  getItemAsync: vi.fn(
    async (key: string, options?: { keychainService?: string }) =>
      keychain.items.get(slot(key, options)) ?? null,
  ),
  setItemAsync: vi.fn(
    async (
      key: string,
      value: string,
      options?: { keychainService?: string; keychainAccessible?: unknown },
    ) => {
      keychain.items.set(slot(key, options), value);
      keychain.accessibility.set(slot(key, options), options?.keychainAccessible);
    },
  ),
  deleteItemAsync: vi.fn(async (key: string, options?: { keychainService?: string }) => {
    keychain.items.delete(slot(key, options));
  }),
}));

import { IOS_KEYCHAIN_SERVICE, make } from "./mobile-secure-storage";

describe("mobile secure storage on iOS", () => {
  it.effect("moves an earlier build's item to the background-readable service on first read", () =>
    Effect.gen(function* () {
      keychain.items.clear();
      keychain.items.set("app/catalog", "saved connections");

      expect(yield* make.getItem("catalog")).toBe("saved connections");
      expect([...keychain.items]).toEqual([
        [`${IOS_KEYCHAIN_SERVICE}/catalog`, "saved connections"],
      ]);
      expect(keychain.accessibility.get(`${IOS_KEYCHAIN_SERVICE}/catalog`)).toBe(
        "after-first-unlock",
      );
      // Later reads come from the new service.
      expect(yield* make.getItem("catalog")).toBe("saved connections");
    }),
  );

  it.effect("removes both copies", () =>
    Effect.gen(function* () {
      keychain.items.clear();
      keychain.items.set("app/catalog", "old");
      keychain.items.set(`${IOS_KEYCHAIN_SERVICE}/catalog`, "new");

      yield* make.removeItem("catalog");

      expect(keychain.items.size).toBe(0);
    }),
  );
});
