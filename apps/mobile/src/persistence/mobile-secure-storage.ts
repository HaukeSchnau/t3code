import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

const MobileSecureStorageOperation = Schema.Literals(["read", "write", "delete"]);

export class MobileSecureStorageError extends Schema.TaggedError<MobileSecureStorageError>()(
  "MobileSecureStorageError",
  {
    operation: MobileSecureStorageOperation,
    key: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Mobile secure storage operation ${this.operation} failed for key ${this.key}.`;
  }
}

export class MobileSecureStorage extends Context.Service<
  MobileSecureStorage,
  {
    readonly getItem: (key: string) => Effect.Effect<string | null, MobileSecureStorageError>;
    readonly setItem: (key: string, value: string) => Effect.Effect<void, MobileSecureStorageError>;
    readonly removeItem: (key: string) => Effect.Effect<void, MobileSecureStorageError>;
  }
>()("@t3tools/mobile/persistence/MobileSecureStorage") {}

/**
 * The iOS keychain service for everything this app stores. Its items stay readable from the
 * first unlock after a reboot, so the native notification Reply handler can read the saved
 * connections while the phone is locked. Keep in sync with the service name in
 * modules/t3-agent-notifications/ios/AgentReplyConnections.swift.
 *
 * Earlier builds used expo-secure-store's defaults, service "app" and WHEN_UNLOCKED. Re-saving
 * can't migrate those items, because expo-secure-store's update path keeps the old protection
 * class, so they move to the new service on first read instead.
 */
export const IOS_KEYCHAIN_SERVICE = "t3code.background";
const iosOptions = {
  keychainService: IOS_KEYCHAIN_SERVICE,
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
} satisfies SecureStore.SecureStoreOptions;
// Android ignores both options, and its existing storage stays as it is.
const writeOptions = () => (Platform.OS === "ios" ? iosOptions : undefined);

const read = (key: string, options?: SecureStore.SecureStoreOptions) =>
  Effect.tryPromise({
    try: () => SecureStore.getItemAsync(key, options),
    catch: (cause) => new MobileSecureStorageError({ operation: "read", key, cause }),
  });

const write = (key: string, value: string, options?: SecureStore.SecureStoreOptions) =>
  Effect.tryPromise({
    try: () => SecureStore.setItemAsync(key, value, options),
    catch: (cause) => new MobileSecureStorageError({ operation: "write", key, cause }),
  });

const remove = (key: string, options?: SecureStore.SecureStoreOptions) =>
  Effect.tryPromise({
    try: () => SecureStore.deleteItemAsync(key, options),
    catch: (cause) => new MobileSecureStorageError({ operation: "delete", key, cause }),
  });

export const make = MobileSecureStorage.of({
  getItem: Effect.fn("MobileSecureStorage.getItem")(function* (key) {
    const options = writeOptions();
    const current = yield* read(key, options);
    if (current !== null || options === undefined) return current;
    const legacy = yield* read(key);
    if (legacy === null) return null;
    // Write before deleting, so an interrupted move leaves a copy behind rather than none.
    yield* write(key, legacy, options);
    yield* remove(key);
    return legacy;
  }),
  setItem: Effect.fn("MobileSecureStorage.setItem")((key, value) =>
    write(key, value, writeOptions()),
  ),
  removeItem: Effect.fn("MobileSecureStorage.removeItem")(function* (key) {
    const options = writeOptions();
    if (options !== undefined) yield* remove(key, options);
    yield* remove(key);
  }),
});

export const layer = Layer.succeed(MobileSecureStorage, make);
