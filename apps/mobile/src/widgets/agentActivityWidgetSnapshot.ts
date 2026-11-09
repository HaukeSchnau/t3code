import type { AgentActivityProps } from "./AgentActivity";

// AgentActivity.tsx creates its Live Activity on load, which Android's expo-widgets module cannot construct.
export function setAgentActivityWidgetSnapshot(_props: AgentActivityProps): void {}
