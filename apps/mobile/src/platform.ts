import { NativeModules, Platform as RN } from "react-native";
import { MOBILE_CLIENT_ID } from "@bye/native-shared/auth";
import { makeNativePlatform } from "@bye/native-shared/platform";

// iOS/Android host: the shared native adapter plus the home-screen widget / share bridge
// (ByeWidgetBridge: WidgetKit on iOS, App Widgets on Android). The mobile OAuth client is used.

interface WidgetBridgeModule {
  publish(json: string): void;
  takePendingShare(): Promise<string | null>;
}

const bridge = NativeModules.ByeWidgetBridge as WidgetBridgeModule | undefined;

export const mobilePlatform = makeNativePlatform({
  name: RN.OS === "ios" ? "ios" : "android",
  deviceName: RN.OS === "ios" ? "iPhone app" : "Android app",
  clientId: MOBILE_CLIENT_ID,
  ...(bridge
    ? {
        widgets: {
          publish: (snapshot) => bridge.publish(JSON.stringify(snapshot)),
          takePendingShare: () => bridge.takePendingShare(),
        },
      }
    : {}),
});
