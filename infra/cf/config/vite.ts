import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import { resolve } from "node:path";
import type { WorkerId } from "./workers.ts";

/** The PWA remains built by apps/web/build.ts; Vite copies its finished public assets. */
export const workerBuildConfig = (id: WorkerId) =>
  defineConfig({
    publicDir: id === "MailCore" ? resolve(import.meta.dirname, "../../../apps/web/dist") : false,
    plugins: [cloudflare({ types: { includeRuntime: false }, remoteBindings: false })],
  });
