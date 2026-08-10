import { expect, it } from "vitest";

import config, { resolveApnsEnvironment } from "./app.config";

it("enables iOS background delivery for remote notifications", () => {
  const notificationsPlugin = config.plugins?.find(
    (plugin) => Array.isArray(plugin) && plugin[0] === "expo-notifications",
  );

  expect(notificationsPlugin).toEqual([
    "expo-notifications",
    expect.objectContaining({
      enableBackgroundRemoteNotifications: true,
      mode: config.extra?.apnsEnvironment === "sandbox" ? "development" : "production",
    }),
  ]);
});

it("embeds the APNs delivery environment in runtime config", () => {
  expect(["sandbox", "production"]).toContain(config.extra?.apnsEnvironment);
});

it("allows signed builds to override the variant's default APNs gateway", () => {
  expect(resolveApnsEnvironment("sandbox", "production")).toBe("sandbox");
  expect(resolveApnsEnvironment(undefined, "development")).toBe("sandbox");
  expect(resolveApnsEnvironment(undefined, "preview")).toBe("production");
  expect(() => resolveApnsEnvironment("staging", "production")).toThrow(
    "T3CODE_APNS_ENVIRONMENT must be either sandbox or production.",
  );
});
