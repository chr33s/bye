import { defineConfig } from "vitest/config";
import { reactNative } from "vitest-native";

// Render tests for the shared screens (packages/native-shared/src/ui) against real React Native JS,
// with only the native-module boundary mocked. Like metro.config.js, react and react-native resolve
// from this app; the workspace packages resolve through their own node_modules.
export default defineConfig({
  plugins: [reactNative({ engine: "native", platform: "ios" })],
  resolve: { dedupe: ["react", "react-native"] },
  server: { fs: { allow: ["../.."] } },
  test: { include: ["test/**/*.test.tsx"] },
});
