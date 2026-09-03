import { createFileRoute } from "@tanstack/react-router";

import { MonitorView } from "../components/MonitorView";

export const Route = createFileRoute("/_chat/monitor")({
  component: MonitorView,
});
