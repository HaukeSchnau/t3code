import { expect, it, vi } from "vite-plus/test";

vi.mock(import("./connection/onboarding"), () => ({ runSignInRecovery: {} as never }));
vi.mock(import("./state/presentation"), () => ({ environmentSummaries: {} as never }));
vi.mock(import("./state/use-atom-command"), () => ({ useAtomCommand: (() => {}) as never }));

import { recoverSignIns } from "./desktopSignInRecovery";

it("runs again for a host that failed while another one was signing in", async () => {
  vi.stubGlobal("window", { desktopBridge: { signInWithOidc: vi.fn() } });
  const first = Promise.withResolvers<void>();
  const recover = vi.fn(() =>
    recover.mock.calls.length === 1 ? first.promise : Promise.resolve(),
  );

  recoverSignIns(recover);
  // Host B fails while A's sign-in is open.
  recoverSignIns(recover);
  expect(recover).toHaveBeenCalledOnce();
  first.resolve();

  await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(2));
  vi.unstubAllGlobals();
});
