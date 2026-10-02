import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  plugins: [cloudflare({ types: { includeRuntime: false }, remoteBindings: false })],
});
