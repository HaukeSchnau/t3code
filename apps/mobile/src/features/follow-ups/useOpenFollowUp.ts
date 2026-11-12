import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, FollowUpId } from "@t3tools/contracts";

/** Opens a follow-up's page, kept by its home environment. */
export function useOpenFollowUp() {
  const navigation = useNavigation();
  return (entry: {
    readonly homeEnvironmentId: EnvironmentId;
    readonly followUp: { readonly id: FollowUpId };
  }) =>
    navigation.navigate("FollowUp", {
      environmentId: String(entry.homeEnvironmentId),
      followUpId: String(entry.followUp.id),
    });
}
