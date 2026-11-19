import { createFileRoute } from "@tanstack/react-router";

import { PagesPage, type PagesSearch } from "../components/pages/PagesPage";

export const Route = createFileRoute("/_chat/pages")({
  validateSearch: (raw: Record<string, unknown>): PagesSearch =>
    raw.filter === "asks" || raw.filter === "unseen" ? { filter: raw.filter } : {},
  component: PagesPage,
});
