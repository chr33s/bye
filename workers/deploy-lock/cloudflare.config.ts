import { defineConfig, bindings, exports } from "cf/config";
import { resolve } from "node:path";
import { OBSERVABILITY } from "../../infra/cf/config/workers.ts";

export default defineConfig(() => {
  const name = process.env.BYE_CF_LOCK_WORKER;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const domain = process.env.BYE_CF_LOCK_DOMAIN;

  if (!name || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(name) || !accountId || !domain)
    throw new Error(
      "lock authority requires explicit Worker name, account and approved custom domain",
    );

  return {
    accountId,
    worker: {
      name,
      entrypoint: resolve(import.meta.dirname, "../../infra/cf/lock-authority.ts"),
      compatibilityDate: "2026-07-30",
      workersDev: false,
      previewUrls: false,
      domains: [domain],
      observability: OBSERVABILITY,
      logpush: false,
      env: {
        LOCK_CREDENTIAL: bindings.secret(),
        LOCK_ADMIN_CREDENTIAL: bindings.secret(),
        WRITER_LOCKS: { type: "unsafe:durable_object_namespace", class_name: "WriterLock" },
      },
      exports: { WriterLock: exports.durableObject({ storage: "sqlite" }) },
    },
  };
});
