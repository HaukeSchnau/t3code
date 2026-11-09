type Environment = Readonly<Record<string, string | undefined>>;

/** The fork provisions iOS identifiers under its own base; see patches/mobile-ios-bundle-identifiers.md. */
export const iosBundleIdentifierBase = (env: Environment) =>
  env.T3CODE_IOS_BUNDLE_IDENTIFIER_BASE?.trim() || "dev.schnau.t3code";

/** The T3 Code Dev client's iOS bundle id or Android package, as apps/mobile/app.config.ts sets it. */
export function developmentClientId(platform: "ios" | "android", env: Environment): string {
  if (platform === "android") return "com.t3tools.t3code.dev";
  const personalTeam =
    env.T3CODE_IOS_PERSONAL_TEAM === "1"
      ? env.T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID?.trim()
      : undefined;
  return personalTeam || `${iosBundleIdentifierBase(env)}.dev`;
}
