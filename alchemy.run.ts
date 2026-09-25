// alchemy.run.ts — deployment code, not a runtime application import (§15.3).
// The stack lives in infra/stack.ts; Workers may only `import type` from it.
export { default } from "./infra/stack.ts";
export type { CoreEnv, PublicEnv } from "./infra/stack.ts";
