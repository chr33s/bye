const path = require("path");
const { getDefaultConfig, mergeConfig } = require("@react-native/metro-config");

// Shared screens live in ../../packages/native-shared. react-native-macos / react-native-windows are resolved
// per platform by the React Native CLI's out-of-tree platform support.
const shared = path.resolve(__dirname, "../../packages/native-shared");
// Workspace packages the shared code imports at runtime, resolved by name through their package
// exports (Effect-free: @bye/domain; @bye/contracts is imported for types only and erased).
const domain = path.resolve(__dirname, "../../packages/domain");

module.exports = mergeConfig(getDefaultConfig(__dirname), {
  watchFolders: [shared, domain],
  resolver: {
    nodeModulesPaths: [path.resolve(__dirname, "node_modules")],
    extraNodeModules: { "@bye/native-shared": shared, "@bye/domain": domain },
    blockList: [
      new RegExp(`${path.resolve(__dirname, "windows").replace(/[/\\]/g, "/")}.*`),
      /.*\.ProjectImports\.zip/,
    ],
  },
});
