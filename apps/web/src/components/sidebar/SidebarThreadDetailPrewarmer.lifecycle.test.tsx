import { RegistryContext, RegistryProvider } from "@effect/atom-react";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { EMPTY_ENVIRONMENT_THREAD_STATE } from "@t3tools/client-runtime/state/threads";
import * as Effect from "effect/Effect";
import * as Atom from "effect/unstable/reactivity/Atom";
import { useContext } from "react";
import type { ReactTestRenderer } from "react-test-renderer";
import TestRenderer from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { environmentThreads, useEnvironmentThreadMount } from "../../state/threads";
import { SidebarThreadDetailPrewarmer } from "./SidebarThreadDetailPrewarmer";

const { act, create } = TestRenderer;

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
});

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

    let registrySpied = false;
    function CaptureRegistryMounts() {
      const registry = useContext(RegistryContext);
      if (!registrySpied) {
        registrySpied = true;
        const mount = registry.mount.bind(registry);
        vi.spyOn(registry, "mount").mockImplementation((atom) => {
          const key = atomKeys.get(atom as ReturnType<typeof environmentThreads.stateAtom>);
          if (key) mounts.push(key);
          const release = mount(atom);
          return () => {
            if (key) releases.push(key);
            release();
          };
        });
      }
      return null;
    }

    const activeThread = parseScopedThreadKey("environment-a:thread-1")!;
    function ActiveThreadOwner() {
      useEnvironmentThreadMount(activeThread.environmentId, activeThread.threadId);
      return null;
    }

    const providerProps = {
      defaultIdleTTL: 1,
      timeoutResolution: 1,
      scheduleTask: (task: () => void) => {
        task();
        return () => undefined;
      },
    } as const;
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <RegistryProvider {...providerProps}>
          <CaptureRegistryMounts />
          <SidebarThreadDetailPrewarmer
            key="prewarm"
            threadKeys={["environment-a:thread-1", "environment-b:thread-2"]}
          />
          <ActiveThreadOwner key="active" />
        </RegistryProvider>,
      );
    });

    expect(mounts).toEqual([
      "environment-a:thread-1",
      "environment-b:thread-2",
      "environment-a:thread-1",
    ]);

    await act(async () => {
      renderer!.update(
        <RegistryProvider {...providerProps}>
          <CaptureRegistryMounts />
          <ActiveThreadOwner key="active" />
        </RegistryProvider>,
      );
      vi.runAllTimers();
    });
    expect(releases).toEqual(["environment-a:thread-1", "environment-b:thread-2"]);

    await act(async () => {
      renderer!.unmount();
      vi.runAllTimers();
    });
    expect(releases).toEqual([
      "environment-a:thread-1",
      "environment-b:thread-2",
      "environment-a:thread-1",
    ]);
  });
});
