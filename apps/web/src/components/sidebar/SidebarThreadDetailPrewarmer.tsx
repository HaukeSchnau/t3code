import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEnvironmentThreadMount } from "../../state/threads";
import { getSidebarThreadIdsToPrewarm } from "../Sidebar.logic";

function SidebarThreadDetailSubscription({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  useEnvironmentThreadMount(threadRef.environmentId, threadRef.threadId);
  return null;
}

export function SidebarThreadDetailPrewarmer({
  threadKeys,
}: {
  readonly threadKeys: readonly string[];
}) {
  const threadRefs = getSidebarThreadIdsToPrewarm(threadKeys).flatMap((threadKey) => {
    const threadRef = parseScopedThreadKey(threadKey);
    return threadRef ? [{ threadKey, threadRef }] : [];
  });

  return threadRefs.map(({ threadKey, threadRef }) => (
    <SidebarThreadDetailSubscription key={threadKey} threadRef={threadRef} />
  ));
}
