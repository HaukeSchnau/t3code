import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  createContext,
  useContext,
  useLayoutEffect,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";

const SidebarCardThreadsContext = createContext<readonly EnvironmentThreadShell[] | null>(null);
const PublishSidebarCardThreadsContext = createContext<Dispatch<
  SetStateAction<readonly EnvironmentThreadShell[] | null>
> | null>(null);

export function SidebarCardThreadsProvider({ children }: { children: ReactNode }) {
  const [threads, setThreads] = useState<readonly EnvironmentThreadShell[] | null>(null);

  return (
    <PublishSidebarCardThreadsContext.Provider value={setThreads}>
      <SidebarCardThreadsContext.Provider value={threads}>
        {children}
      </SidebarCardThreadsContext.Provider>
    </PublishSidebarCardThreadsContext.Provider>
  );
}

export function usePublishSidebarCardThreads(threads: readonly EnvironmentThreadShell[]) {
  const publish = useContext(PublishSidebarCardThreadsContext);

  useLayoutEffect(() => {
    publish?.(threads);
  }, [publish, threads]);

  useLayoutEffect(
    () => () => {
      publish?.(null);
    },
    [publish],
  );
}

export function useSidebarCardThreads(): readonly EnvironmentThreadShell[] | null {
  return useContext(SidebarCardThreadsContext);
}
