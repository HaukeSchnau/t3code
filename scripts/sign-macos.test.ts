import { sign as signApplication, type SignOptions } from "@electron/osx-sign";
import { expect, it, vi } from "vite-plus/test";

import sign from "./sign-macos.ts";

vi.mock("@electron/osx-sign", () => ({ sign: vi.fn() }));

it("batches codesign calls without changing existing signing options", async () => {
  const options = {
    app: "/tmp/T3 Code.app",
    identity: "Developer ID Application: T3 Tools, Inc.",
    keychain: "/tmp/t3code.keychain",
    provisioningProfile: "/tmp/t3code.provisionprofile",
    optionsForFile: () => ({
      entitlements: "/tmp/t3code.entitlements.plist",
      hardenedRuntime: true,
    }),
  } satisfies SignOptions;

  await sign(options);

  expect(signApplication).toHaveBeenCalledExactlyOnceWith({
    ...options,
    batchCodesignCalls: true,
  });
});

it("applies the designated requirement to the main bundle only", async () => {
  vi.mocked(signApplication).mockClear();
  vi.stubEnv(
    "T3CODE_MACOS_DESIGNATED_REQUIREMENT",
    'designated => identifier "dev.example.app" and anchor apple generic',
  );
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
  vi.unstubAllEnvs();
});
