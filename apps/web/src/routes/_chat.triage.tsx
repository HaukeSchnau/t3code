import { createFileRoute } from "@tanstack/react-router";

import { TriagePage } from "../components/needsYou/TriagePage";

export const Route = createFileRoute("/_chat/triage")({
  component: TriagePage,
});
