import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// The public Expo config keys that switch on upstream's T3 Connect code in the
// mobile app. The app treats each one as set when it holds a non-empty string.
const PublicCloudConfig = Schema.Struct({
  extra: Schema.optional(
    Schema.Struct({
      clerk: Schema.optional(
        Schema.Struct({
          publishableKey: Schema.optional(Schema.Unknown),
          jwtTemplate: Schema.optional(Schema.Unknown),
        }),
      ),
      relay: Schema.optional(Schema.Struct({ url: Schema.optional(Schema.Unknown) })),
    }),
  ),
});
const decodePublicCloudConfig = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PublicCloudConfig),
);

/** Lists the T3 Connect settings present in a decoded public Expo config. */
export function configuredCloudSettings(
  config: typeof PublicCloudConfig.Type,
): ReadonlyArray<string> {
  const settings = {
    "extra.clerk.publishableKey": config.extra?.clerk?.publishableKey,
    "extra.clerk.jwtTemplate": config.extra?.clerk?.jwtTemplate,
    "extra.relay.url": config.extra?.relay?.url,
  };
  return Object.entries(settings)
    .filter(([, value]) => typeof value === "string" && value.trim() !== "")
    .map(([setting]) => setting);
}

export class AccountlessBuildError extends Schema.TaggedError<AccountlessBuildError>()(
  "AccountlessBuildError",
  { settings: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return [
      `Refusing to ship T3 Connect config in a fork build: ${this.settings.join(", ")} set.`,
      "Unset T3CODE_CLERK_*, VITE_CLERK_*, EXPO_PUBLIC_CLERK_*, T3CODE_RELAY_URL and",
      "VITE_T3CODE_RELAY_URL in the runner's environment and the repository's root .env/.env.local.",
    ].join(" ");
  }
}

/**
 * Fails when the output of `expo config --type public --json` would turn on
 * T3 Connect. Fork distribution scripts run this before shipping a binary or
 * an update, because the fork stays accountless
 * (patches/accountless-direct-agent-awareness.md).
 */
export const requireAccountlessExpoConfig = Effect.fn("requireAccountlessExpoConfig")(function* (
  publicConfigJson: string,
) {
  const settings = configuredCloudSettings(yield* decodePublicCloudConfig(publicConfigJson));
  if (settings.length > 0) return yield* new AccountlessBuildError({ settings });
});
