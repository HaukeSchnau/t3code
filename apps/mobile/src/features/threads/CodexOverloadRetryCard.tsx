import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";

/** Says whether Codex retries an at-capacity model by itself, beside the composer's Resume. */
export function CodexOverloadRetryCard({ notice }: { notice: string | null }) {
  if (notice === null) return null;
  return (
    <View className="mx-3 mb-2 gap-1 rounded-xl border border-warning-foreground/25 bg-background p-3">
      <Text className="text-sm font-t3-medium text-warning-foreground">Model at capacity</Text>
      <Text className="text-sm text-foreground">{notice}</Text>
    </View>
  );
}
