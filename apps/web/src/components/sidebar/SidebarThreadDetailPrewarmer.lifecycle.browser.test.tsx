import { RegistryContext, RegistryProvider } from "@effect/atom-react";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { EMPTY_ENVIRONMENT_THREAD_STATE } from "@t3tools/client-runtime/state/threads";
import * as Effect from "effect/Effect";
import * as Atom from "effect/reactivity/Atom";
import { useContext, useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../../test/render";
import { environmentThreads, useEnvironmentThreadMount } from "../../state/threads";
import { SidebarThreadDetailPrewarmer } from "./SidebarThreadDetailPrewarmer";

describe("SidebarThreadDetailPrewarmer lifecycle", () => {
  it("shares active atoms and releases background ownership", async () => {
    using _timers = fakeTimers();
    const atoms = new Map<string, ReturnType<typeof environmentThreads.stateAtom>>();
    const atomKeys = new Map<ReturnType<typeof environmentThreads.stateAtom>, string>();
    const mounts: string[] = [];
    const releases: string[] = [];
    using _stateAtom = vi
      .spyOn(environmentThreads, "stateAtom")
      .mockImplementation((environmentId, threadId) => {
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
    // Mount order is the assertion, so render the tree directly instead of through a router outlet.
    await using screen = await render(
      withRegistry([
        <SidebarThreadDetailPrewarmer
          key="prewarm"
          threadKeys={["environment-a:thread-1", "environment-b:thread-2"]}
        />,
        <ActiveThreadOwner key="active" />,
      ]),
      { router: false },
    );

    expect(mounts).toEqual([
      "environment-a:thread-1",
      "environment-b:thread-2",
      "environment-a:thread-1",
    ]);

    await screen.rerender(withRegistry([<ActiveThreadOwner key="active" />]));
    await act(() => vi.runAllTimers());
    expect(releases).toEqual(["environment-a:thread-1", "environment-b:thread-2"]);

    await screen.unmount();
    await act(() => vi.runAllTimers());
    expect(releases).toEqual([
      "environment-a:thread-1",
      "environment-b:thread-2",
      "environment-a:thread-1",
    ]);
  });
});
