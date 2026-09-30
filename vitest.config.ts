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
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**", "workers/*/src/**", "apps/web/src/**", "apps/cli/src/**"],
      // The shared RN screens are covered by apps/mobile's own vitest-native suite.
      exclude: ["packages/native-shared/src/ui/**"],
      reporter: ["text-summary", "json-summary", "lcov"],
      reportsDirectory: "coverage",
      // A ratchet, ~2 points under the measured baseline per package: coverage may rise, not fall.
      // Raise these when a change lifts a package; never lower them to land one.
      thresholds: {
        lines: 84,
        branches: 72,
        functions: 77,
        statements: 81,
        "apps/cli/src/**": { lines: 80, branches: 69, functions: 74, statements: 77 },
        "apps/web/src/**": { lines: 42, branches: 31, functions: 35, statements: 42 },
        "packages/application/src/**": { lines: 92, branches: 88, functions: 87, statements: 92 },
        "packages/calendar-engine/src/**": {
          lines: 94,
          branches: 85,
          functions: 91,
          statements: 92,
        },
        "packages/contracts/src/**": { lines: 97, branches: 90, functions: 80, statements: 97 },
        "packages/domain/src/**": { lines: 95, branches: 94, functions: 96, statements: 94 },
        "packages/mail-codec/src/**": { lines: 95, branches: 83, functions: 96, statements: 92 },
        "packages/native-shared/src/**": { lines: 89, branches: 79, functions: 83, statements: 86 },
        "packages/platform-cloudflare/src/**": {
          lines: 90,
          branches: 79,
          functions: 88,
          statements: 87,
        },
        "packages/testing/src/**": { lines: 94, branches: 85, functions: 92, statements: 92 },
        "workers/core/src/**": { lines: 85, branches: 69, functions: 81, statements: 82 },
        "workers/public/src/**": { lines: 92, branches: 83, functions: 83, statements: 91 },
        "workers/push-gateway/src/**": { lines: 88, branches: 71, functions: 83, statements: 84 },
        "workers/sigmirror/src/**": { lines: 97, branches: 89, functions: 92, statements: 94 },
      },
    },
  },
});
