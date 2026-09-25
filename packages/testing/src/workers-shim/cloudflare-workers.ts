// Node test shim for the `cloudflare:workers` module. Mirrors only the base-class shape the
// Worker code relies on (ctx/env fields); runtime semantics come from the in-memory harness.

export abstract class DurableObject<Env = unknown> {
  protected ctx: any;
  protected env: Env;
  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export abstract class WorkerEntrypoint<Env = unknown> {
  protected ctx: any;
  protected env: Env;
  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export abstract class WorkflowEntrypoint<Env = unknown> {
  protected ctx: any;
  protected env: Env;
  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
