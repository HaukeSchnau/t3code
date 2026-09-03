/**
 * `/prototypes/sidebar-organization` — interactive prototype of the
 * orchestration sidebar organisation rules. Server-free: the root route
 * skips the auth gate for `/prototypes/*`, so a static build serves it.
 */
import { createFileRoute } from "@tanstack/react-router";

import { SidebarOrganizationPrototypePage } from "../components/sidebar-organization-prototype/SidebarOrganizationPrototypePage";

export const Route = createFileRoute("/prototypes/sidebar-organization")({
  component: SidebarOrganizationPrototypePage,
});
