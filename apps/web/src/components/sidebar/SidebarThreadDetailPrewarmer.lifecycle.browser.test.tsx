import { RegistryContext, RegistryProvider } from "@effect/atom-react";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { EMPTY_ENVIRONMENT_THREAD_STATE } from "@t3tools/client-runtime/state/threads";
import * as Effect from "effect/Effect";
import * as Atom from "effect/reactivity/Atom";
import { act, useContext, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { environmentThreads, useEnvironmentThreadMount } from "../../state/threads";
import { SidebarThreadDetailPrewarmer } from "./SidebarThreadDetailPrewarmer";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("SidebarThreadDetailPrewarmer lifecycle", () => {
  it("shares active atoms and releases background ownership", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const atoms = new Map<string, ReturnType<typeof environmentThreads.stateAtom>>();
    const atomKeys = new Map<ReturnType<typeof environmentThreads.stateAtom>, string>();
    const mounts: string[] = [];
    const releases: string[] = [];
    vi.spyOn(environmentThreads, "stateAtom").mockImplementation((environmentId, threadId) => {
      const key = `${environmentId}:${threadId}`;
      const existing = atoms.get(key);
      if (existing) return existing;

      const atom = Atom.make(Effect.succeed(EMPTY_ENVIRONMENT_THREAD_STATE));
      atoms.set(key, atom);
      atomKeys.set(atom, key);
      return atom;
    });

    function CaptureRegistryMounts() {
      const registry = useContext(RegistryContext);
      // Spies once, before the siblings below mount their atoms.
      useState(() => {
        const mount = registry.mount.bind(registry);
        return vi.spyOn(registry, "mount").mockImplementation((atom) => {
          const key = atomKeys.get(atom as ReturnType<typeof environmentThreads.stateAtom>);
          if (key) mounts.push(key);
          const release = mount(atom);
          return () => {
            if (key) releases.push(key);
            release();
          };
        });
      });
      return null;
    }

    const activeThread = parseScopedThreadKey("environment-a:thread-1")!;
    function ActiveThreadOwner() {
      useEnvironmentThreadMount(activeThread.environmentId, activeThread.threadId);
      return null;
    }

    // One props object: a new scheduleTask would make the provider build a new registry.
    const providerProps = {
      defaultIdleTTL: 1,
      timeoutResolution: 1,
      scheduleTask: (task: () => void) => {
        task();
        return () => undefined;
      },
    } as const;
    // Keyed siblings in an array both times, so React keeps the active owner mounted.
    const withRegistry = (children: ReadonlyArray<ReactNode>) => (
      <RegistryProvider {...providerProps}>
        <CaptureRegistryMounts />
        {children}
      </RegistryProvider>
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          withRegistry([
            <SidebarThreadDetailPrewarmer
              key="prewarm"
              threadKeys={["environment-a:thread-1", "environment-b:thread-2"]}
            />,
            <ActiveThreadOwner key="active" />,
          ]),
        );
      });

      expect(mounts).toEqual([
        "environment-a:thread-1",
        "environment-b:thread-2",
        "environment-a:thread-1",
      ]);

      await act(async () => {
        root.render(withRegistry([<ActiveThreadOwner key="active" />]));
        vi.runAllTimers();
      });
      expect(releases).toEqual(["environment-a:thread-1", "environment-b:thread-2"]);

      await act(async () => {
        root.unmount();
        vi.runAllTimers();
      });
      expect(releases).toEqual([
        "environment-a:thread-1",
        "environment-b:thread-2",
        "environment-a:thread-1",
      ]);
    } finally {
      container.remove();
    }
  });
});
