import { sign as signApplication } from "@electron/osx-sign";
import { expect, it, vi } from "vite-plus/test";

import sign from "./sign-macos.ts";

vi.mock("@electron/osx-sign", () => ({ sign: vi.fn() }));

it("applies the designated requirement to the main bundle only", async () => {
  vi.stubEnv(
    "T3CODE_MACOS_DESIGNATED_REQUIREMENT",
    'designated => identifier "dev.example.app" and anchor apple generic',
  );
  try {
    const entitlements = { entitlements: "/tmp/t3code.entitlements.plist", hardenedRuntime: true };
    const app = "/tmp/T3 Code.app";

    await sign({ app, identity: "Apple Development: Example", optionsForFile: () => entitlements });

    const forwarded = vi.mocked(signApplication).mock.calls[0]?.[0];
    const context = { platform: "darwin" } as const;
    expect(forwarded?.optionsForFile?.(app, context)).toEqual({
      ...entitlements,
      requirements: '=designated => identifier "dev.example.app" and anchor apple generic',
    });
    expect(forwarded?.optionsForFile?.(`${app}/Contents/Frameworks/Helper.app`, context)).toEqual(
      entitlements,
    );
  } finally {
    vi.unstubAllEnvs();
  }
});
