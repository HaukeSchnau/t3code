import { StackActions, useNavigation } from "@react-navigation/native";
import { useCallback, useEffect } from "react";
import { ActivityIndicator, Platform, View } from "react-native";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { forgetPendingThreadCreation } from "./pendingThreadNavigation";

export function PendingThreadCreationScreen(props: {
  readonly environmentId: string;
  readonly threadId: string;
  readonly title: string;
}) {
  const navigation = useNavigation();
  const handleBack = useCallback(() => {
    if (navigation.canGoBack()) {
      navigation.goBack();
      return;
    }
    navigation.dispatch(StackActions.replace("Home"));
  }, [navigation]);

  useEffect(
    () => () => forgetPendingThreadCreation(props.environmentId, props.threadId),
    [props.environmentId, props.threadId],
  );

  return (
    <View className="flex-1 bg-screen">
      <NativeStackScreenOptions
        options={{
          headerShown: Platform.OS !== "android",
          headerTitle: props.title,
          title: props.title,
        }}
      />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader title={props.title} onBack={handleBack} />
      ) : null}
      <View className="flex-1 items-center justify-center gap-4 px-8">
        <ActivityIndicator size="large" />
        <Text className="text-center text-lg font-t3-bold text-foreground">Creating thread…</Text>
        <Text className="max-w-sm text-center text-sm leading-relaxed text-foreground-muted">
          Your task is saved on this device. It will open here when the environment confirms it. You
          can go back to edit or remove the pending task.
        </Text>
      </View>
    </View>
  );
}
