import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const shim = (name: string) =>
  fileURLToPath(new URL(`./packages/testing/src/workers-shim/${name}.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // Worker modules are exercised in Node against in-memory bindings; see workers/core/test/harness.ts.
    alias: {
      "cloudflare:workers": shim("cloudflare-workers"),
      "cloudflare:email": shim("cloudflare-email"),
    },
  },
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "workers/*/test/**/*.test.ts",
      "infra/tests/**/*.test.ts",
      "infra/state/test/**/*.test.ts",
      "apps/*/test/**/*.test.ts",
      "containers/*/test/**/*.test.ts",
    ],
    // Wall-clock thresholds are machine-dependent: the evidence bench runs only through
    // `pnpm evidence:bench` (which sets BYE_BENCH_MESSAGES), never in the default suite.
    exclude: [
      ...configDefaults.exclude,
      ...(process.env.BYE_BENCH_MESSAGES ? [] : ["infra/tests/evidence-bench.test.ts"]),
    ],
    environment: "node",
    testTimeout: 20_000,
  },
});
