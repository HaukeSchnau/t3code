import { expect, it, vi } from "vite-plus/test";

vi.mock(import("./connection/onboarding"), () => ({ runSignInRecovery: {} as never }));
vi.mock(import("./state/presentation"), () => ({ environmentSummaries: {} as never }));
vi.mock(import("./state/use-atom-command"), () => ({ useAtomCommand: (() => {}) as never }));

import { recoverSignIns } from "./desktopSignInRecovery";

it("runs again for a host that failed while another one was signing in", async () => {
  vi.stubGlobal("window", { desktopBridge: { signInWithOidc: vi.fn() } });
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  const recover = vi.fn(() => {
    if (recover.mock.calls.length === 1) return first.promise;
    second.resolve();
    return Promise.resolve();
  });

  recoverSignIns(recover);
  // Host B fails while A's sign-in is open.
  recoverSignIns(recover);
  expect(recover).toHaveBeenCalledOnce();
  first.resolve();

  await second.promise;
  expect(recover).toHaveBeenCalledTimes(2);
  vi.unstubAllGlobals();
});
