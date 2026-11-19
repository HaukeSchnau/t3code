// @effect-diagnostics globalTimers:off - The badge refreshes on plain timers outside an Effect runtime.
import * as Notifications from "expo-notifications";
import type { AtomRegistry } from "effect/reactivity";
import { Platform } from "react-native";

import { environmentThreadShells } from "../../state/threads";
import { readAppIconCount } from "./remoteRegistration";

/** Thread changes come in bursts while agents work; one read covers a burst. */
const READ_DELAY_MS = 2_000;

/**
 * Keeps the app icon's count at the needs-you count of the server that sends this device's
 * pushes while the app runs, the same number those pushes set while the app is closed, so the
 * icon never switches between two scopes, and clears it once no server is paired. The count is
 * cached only once the icon took it.
 */
export function installAppIconBadge(registry: AtomRegistry.AtomRegistry): () => void {
  if (Platform.OS !== "ios") return () => {};
  let shown: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // One read and write at a time, so an older read can't overwrite a newer count; a trigger
  // during a sync asks for one more fresh read after it.
  let syncing = false;
  let again = false;
  const sync = async () => {
    if (syncing) {
      again = true;
      return;
    }
    syncing = true;
    try {
      do {
        again = false;
        const count = await readAppIconCount();
        if (count === null || count === shown) continue;
        const written = await Notifications.setBadgeCountAsync(count).catch(() => false);
        if (written) shown = count;
      } while (again);
    } finally {
      syncing = false;
    }
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void sync(), READ_DELAY_MS);
  };
  const unsubscribe = registry.subscribe(
    environmentThreadShells.navigationThreadShellsAtom,
    schedule,
    { immediate: true },
  );
  // Snoozes end without a thread change.
  const interval = setInterval(schedule, 60_000);
  return () => {
    unsubscribe();
    clearTimeout(timer);
    clearInterval(interval);
  };
}
