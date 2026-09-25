import { DeviceEventEmitter, NativeModules, Platform as RN } from "react-native";
import { makeNativePlatform, type Platform } from "@bye/native-shared/platform";

// macOS/Windows host: the shared native adapter plus Windows protocol activation. bye:// links on
// Windows arrive through the ByeActivation module (single instance) where Linking isn't wired.

const activation = NativeModules.ByeActivation as { getInitialUrl(): Promise<string> } | undefined;
const windowsUrls: Platform["urls"] =
  RN.OS === "windows" && activation
    ? {
        initial: async () => (await activation.getInitialUrl()) || null,
        subscribe: (listener) => {
          const sub = DeviceEventEmitter.addListener("byeUrl", (url: string) => listener(url));
          return () => sub.remove();
        },
      }
    : undefined;

export const desktopPlatform = makeNativePlatform({
  name: RN.OS === "windows" ? "windows" : "macos",
  deviceName: RN.OS === "windows" ? "Windows desktop app" : "Mac desktop app",
  ...(windowsUrls ? { urls: windowsUrls } : {}),
});
