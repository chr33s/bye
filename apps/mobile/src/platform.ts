import { NativeEventEmitter, NativeModules, Platform as RN } from "react-native";
import { MOBILE_CLIENT_ID } from "@bye/native-shared/auth";
import {
  decodePushToken,
  encodeWidgetSnapshot,
  makeNativePlatform,
  type Platform,
} from "@bye/native-shared/platform";

// iOS/Android host: the shared native adapter plus the home-screen widget / share bridge
// (ByeWidgetBridge: WidgetKit on iOS, App Widgets on Android) and the push bridge (ByePush: APNs
// on iOS, FCM on Android). The mobile OAuth client is used.

interface WidgetBridgeModule {
  publish(json: string): void;
  takePendingShare(): Promise<string | null>;
}

const bridge = NativeModules.ByeWidgetBridge as WidgetBridgeModule | undefined;

/** ByePush.swift / ByePushModule.kt. Tokens cross the bridge as JSON; keys stay native. */
interface PushModule {
  requestToken(): Promise<string | null>;
  takeInitialOpen(): Promise<string | null>;
  addListener(event: string): void;
  removeListeners(count: number): void;
}

const pushModule = NativeModules.ByePush as PushModule | undefined;

const pushBridge = (module: PushModule, label: string): NonNullable<Platform["push"]> => {
  const events = new NativeEventEmitter(module);

  return {
    label,
    requestToken: async () => decodePushToken(await module.requestToken()),
    onTokenRefresh: (listener) => {
      const sub = events.addListener("ByePushToken", () => listener());

      return () => sub.remove();
    },
    initialOpen: () => module.takeInitialOpen(),
    onOpen: (listener) => {
      const sub = events.addListener("ByePushOpen", (url) => {
        if (typeof url === "string") listener(url);
      });

      return () => sub.remove();
    },
  };
};

const deviceName = RN.OS === "ios" ? "iPhone app" : "Android app";

export const mobilePlatform = makeNativePlatform({
  name: RN.OS === "ios" ? "ios" : "android",
  deviceName,
  clientId: MOBILE_CLIENT_ID,
  ...(bridge
    ? {
        widgets: {
          publish: (snapshot) => {
            const json = encodeWidgetSnapshot(snapshot);

            if (json) bridge.publish(json);
          },
          takePendingShare: () => bridge.takePendingShare(),
        },
      }
    : {}),
  ...(pushModule ? { push: pushBridge(pushModule, deviceName) } : {}),
});
