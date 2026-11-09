import { AgentActivityWidget, type AgentActivityProps } from "./AgentActivity";

export function setAgentActivityWidgetSnapshot(props: AgentActivityProps): void {
  AgentActivityWidget.updateSnapshot(props);
}
