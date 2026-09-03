import { useCallback, useState } from "react";

/** Native lists start folded and remember choices for the lifetime of the list. */
export function useThreadOrchestrationExpansion() {
  const [expandedContainers, setExpandedContainers] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const isExpanded = useCallback(
    (containerId: string) => expandedContainers.has(containerId),
    [expandedContainers],
  );
  const toggle = useCallback((containerId: string) => {
    setExpandedContainers((current) => {
      const next = new Set(current);
      if (next.has(containerId)) next.delete(containerId);
      else next.add(containerId);
      return next;
    });
  }, []);
  const reveal = useCallback((containerIds: ReadonlyArray<string>) => {
    setExpandedContainers((current) => new Set([...current, ...containerIds]));
  }, []);
  return { isExpanded, toggle, reveal };
}
