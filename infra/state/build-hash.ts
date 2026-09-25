import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Identity of the state Worker's source (§15.7 "verify the actually deployed state Worker").
// The foundation stack binds it as STATE_BUILD_HASH at deploy; `/version` reports it; CI recomputes
// it from the reviewed commit and refuses to deploy against a backend running different code.

export const STATE_WORKER_SOURCES = [
  "core.ts",
  "worker.ts",
  "../../packages/domain/src/bytes.ts",
] as const;

export const stateBuildHash = (dir = import.meta.dirname): string => {
  const hash = createHash("sha256");
  for (const file of STATE_WORKER_SOURCES) {
    hash.update(`${file}\0`);
    hash.update(readFileSync(join(dir, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
};
