import { createFileRoute } from "@tanstack/react-router";

import { FollowUpsPage, type FollowUpsSearch } from "../components/followUps/FollowUpsPage";

export const Route = createFileRoute("/_chat/follow-ups")({
  validateSearch: (raw: Record<string, unknown>): FollowUpsSearch => ({
    ...(typeof raw.home === "string" && raw.home.trim()
      ? { home: raw.home.trim().slice(0, 200) }
      : {}),
    ...(typeof raw.id === "string" && raw.id.trim() ? { id: raw.id.trim().slice(0, 200) } : {}),
    ...(raw.closed === true || raw.closed === "true" ? { closed: true } : {}),
    ...(raw.view === "graph" ? { view: "graph" } : {}),
  }),
  component: FollowUpsPage,
});
