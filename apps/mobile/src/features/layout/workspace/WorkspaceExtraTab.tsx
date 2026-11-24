import { type NavigationTab } from "./navigation-tab-order";
import { NativeStackScreenOptions } from "../../../native/StackHeader";
import { FollowUpsScreen } from "../../follow-ups/FollowUpsScreen";
import { UsageRouteScreen } from "../../usage/UsageRouteScreen";
import { WorkflowsScreen } from "../../workflows/WorkflowsScreen";

export function WorkspaceExtraTab(props: {
  tab: Extract<NavigationTab, "usage" | "workflows" | "followUps">;
}) {
  return (
    <>
      <NativeStackScreenOptions options={{ headerSearchBarOptions: undefined }} />
      {props.tab === "followUps" ? (
        <FollowUpsScreen />
      ) : props.tab === "workflows" ? (
        <WorkflowsScreen />
      ) : (
        <UsageRouteScreen workspace />
      )}
    </>
  );
}
